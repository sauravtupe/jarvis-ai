import logging
import time
from dataclasses import dataclass, field
from typing import List, Optional
from urllib.parse import quote, urlparse
from concurrent.futures import ThreadPoolExecutor, as_completed, TimeoutError as FuturesTimeoutError
from config import TASK_EXECUTION_TIMEOUT, POLLINATIONS_TOKEN, POLLINATIONS_REFERRER
from app.services.decision_types import (
    INTENT_OPEN, INTENT_PLAY, INTENT_CAMERA,
    INTENT_OPEN_WEBCAM, INTENT_CLOSE_WEBCAM,
    INTENT_GENERATE_IMAGE, INTENT_CONTENT,
    INTENT_GOOGLE_SEARCH, INTENT_YOUTUBE_SEARCH, INTENT_CHAT,
)

logger = logging.getLogger("J.A.R.V.I.S")

@dataclass
class TaskResponse:
    text: str = ""
    wopens: List[str] = field(default_factory=list)
    plays: List[str] = field(default_factory=list)
    images: List[str] = field(default_factory=list)
    contents: List[str] = field(default_factory=list)
    googlesearches: List[str] = field(default_factory=list)
    youtubesearches: List[str] = field(default_factory=list)
    cam: Optional[dict] = None

class TaskExecutor:
    def __init__(self, groq_service=None):
        self.groq_service = groq_service
        logger.info("[TASK] TaskExecutor initialized (Pollinations.ai for images)")

    def execute(
        self,
        intents: List[tuple],
        chat_history: Optional[List[tuple]] = None,
    ) -> TaskResponse:
        
        response = TaskResponse()

        tasks = []
        for intent_type, payload in intents:
            if intent_type == INTENT_OPEN:
                tasks.append(("wopen", self._do_open, payload))
            
            elif intent_type == INTENT_PLAY:
                tasks.append(("play", self._do_play, payload))
            
            elif intent_type == INTENT_GENERATE_IMAGE:
                tasks.append(("image", self._do_generate_image, payload))
            
            elif intent_type == INTENT_CONTENT:
                tasks.append(("content", lambda p: self._do_content(p, chat_history), payload))
            
            elif intent_type == INTENT_GOOGLE_SEARCH:
                tasks.append(("google", self._do_google_search, payload))
            
            elif intent_type == INTENT_YOUTUBE_SEARCH:
                tasks.append(("youtube", self._do_youtube_search, payload))
            
            elif intent_type == INTENT_OPEN_WEBCAM:
                response.cam = {"action": "open"}
                response.text = "Opening the webcam for you."
            
            elif intent_type == INTENT_CLOSE_WEBCAM:
                response.cam = {"action": "close"}
                response.text = "Webcam closed."
            
            elif intent_type == INTENT_CAMERA:
                response.cam = {"action": "open"}
                response.text = "Opening your webcam. Once it's on, send your message again and I'll describe what I see."
            
            elif intent_type == INTENT_CHAT:
                pass
        
        if not tasks:
            if not response.text and not response.cam:
                response.text = "I'm not sure what you'd like me to do. Could you clarify?"
            return response

        t0 = time.perf_counter()
        failed_tags = []

        try:
            with ThreadPoolExecutor(max_workers=min(6, len(tasks))) as executor:
                futures = {
                    executor.submit(fn, p): (tag, fn, p)
                    for tag, fn, p in tasks
                }

                for future in as_completed(futures, timeout=TASK_EXECUTION_TIMEOUT):
                    tag, fn, payload = futures[future]

                    try:
                        result = future.result()
                        if tag == "wopen" and result:
                            response.wopens.append(result)

                        elif tag == "play" and result:
                            response.plays.append(result)

                        elif tag == "image" and result:
                            response.images.append(result)

                        elif tag == "content" and result:
                            response.contents.append(result)

                        elif tag == "google" and result:
                            response.googlesearches.append(result)

                        elif tag == "youtube" and result:
                            response.youtubesearches.append(result)

                    except Exception as e:
                        failed_tags.append(tag)
                        err_msg = str(e)[:100]
                        logger.warning("[TASK] Task %s failed: %s", tag, e)

                        if "content_policy" in err_msg.lower() or "safety" in err_msg.lower():
                            if tag == "image":
                                response.text = "I couldn't generate that image - it may violate content guidelines."
                    
                        elif not response.text:
                            response.text = f"Something went wrong with that task: {err_msg}"

        except FuturesTimeoutError:
            logger.warning("[TASK] Task execution timed out after %ds", TASK_EXECUTION_TIMEOUT)
            if not response.text:
                response.text = "Some tasks took too long. Please try again."

        elapsed = time.perf_counter() - t0
        logger.info("[TASK] Executed %d tasks in %.2fs (failed: %s)", len(tasks), elapsed, failed_tags or "none")

        if not response.text:
            parts = self._build_conversational_response(
                response.wopens, response.plays, response.images,
                response.contents, response.googlesearches, response.youtubesearches,
            )
            response.text = parts if parts else "All done."

        return response
    
    def _url_to_display_name(self, url: str) -> str:
        u = (url or "").lower()
        mapping = {
            "facebook.com": "Facebook", "instagram.com": "Instagram", "youtube.com": "YouTube",
            "google.com": "Google", "netflix.com": "Netflix", "twitter.com": "Twitter",
            "x.com": "X", "gmail.com": "Gmail", "whatsapp.com": "WhatsApp",
            "linkedin.com": "LinkedIn", "reddit.com": "Reddit", "discord.com": "Discord",
            "spotify.com": "Spotify", "tiktok.com": "TikTok", "amazon.com": "Amazon",
            "github.com": "GitHub", "wikipedia.org": "Wikipedia", "stackoverflow.com": "Stack Overflow",
            "medium.com": "Medium", "notion.so": "Notion", "figma.com": "Figma",
            "canva.com": "Canva", "zoom.us": "Zoom", "drive.google.com": "Google Drive",
            "jarvisforeveryone.com": "Jarvis for Everyone", "graphy.com": "Graphy",
        }

        for key, name in mapping.items():
            if key in u:
                return name

        try:
            parsed = urlparse(url)
            domain = (parsed.netloc or parsed.path or "").replace("www.", "").split(".")[0]
            return domain.title() if domain else "the link"
        except Exception:
            return "the link"

    def _build_conversational_response(
        self,
        wopens: List[str],
        plays: List[str],
        images: List[str],
        contents: List[str],
        googlesearches: List[str],
        youtubesearches: List[str],
    ) -> str:

        parts = []

        if wopens:
            names = [self._url_to_display_name(u) for u in wopens]

            if len(names) == 1:
                parts.append(f"I've opened {names[0]} for you.")
            else:
                last = names[-1]
                rest = ", ".join(names[:-1])
                parts.append(f"I've opened {rest} and {last} for you.")

        if plays:
            parts.append("I've started playing that for you.")

        if images:
            count = len(images)
            parts.append(f"I've generated the image{'s' if count > 1 else ''} for you.")

        if contents:
            parts.append("I've written that for you.")

        if googlesearches or youtubesearches:
            parts.append("I've run the search for you.")

        return " ".join(parts) if parts else "Done."
    

    def _validate_url(self, url: str) -> Optional[str]:
        if not url or len(url) > 2048:
            return None
        u = url.strip()

        if not u.startswith("http"):
            u = "https://" + u

        try:
            parsed = urlparse(u)

            if parsed.scheme not in ("http", "https"):
                logger.warning("[TASK] Rejected non-http URL: %s", u[:50])
                return None
        
            return u
        except Exception:
            return None

    def _do_open(self, payload: dict) -> Optional[str]:
        url = payload.get("url", "").strip()

        if not url:
            return None
        return self._validate_url(url)

    def _do_play(self, payload: dict) -> Optional[str]:
        query = (payload.get("query", payload.get("message", "")) or "").strip()[:500]
        if not query:
            return "https://www.youtube.com"
        return f"https://www.youtube.com/results?search_query={quote(query, safe='')}"


    def _do_generate_image(self, payload: dict) -> tuple:

        prompt = (payload.get("prompt", payload.get("message", "")) or "").strip()

        if len(prompt) < 3:
            logger.warning("[TASK] Image prompt too short (< 3 chars)")
            raise ValueError("Tell me what to draw — the image prompt was empty.")

        prompt = prompt[:4000]
        t0 = time.perf_counter()

        # Raises a descriptive error on failure (the real cause reaches the user).
        result = self._generate_pollinations(prompt)
        logger.info("[TASK] Pollinations image downloaded in %.2fs", time.perf_counter() - t0)
        return result


    def _generate_pollinations(self, prompt: str) -> tuple:
        """Download the generated image and return (url, bytes).

        Raises RuntimeError on persistent failure so the REAL reason (e.g. HTTP 429
        rate-limit from a shared cloud IP) reaches the user instead of a misleading
        generic message. A free POLLINATIONS_TOKEN (auth.pollinations.ai) lifts the
        request off the throttled anonymous tier — this is what makes image generation
        work from the HF Space's datacenter IP.
        """
        import httpx
        encoded_prompt = quote(prompt, safe='')
        params = "model=flux&width=1024&height=1024&nologo=true&private=true&enhance=true&safe=false"
        if POLLINATIONS_REFERRER:
            params += f"&referrer={quote(POLLINATIONS_REFERRER, safe='')}"
        api_url = f"https://image.pollinations.ai/prompt/{encoded_prompt}?{params}"

        headers = {"User-Agent": "Jarvis-AI/1.0"}
        if POLLINATIONS_TOKEN:
            headers["Authorization"] = f"Bearer {POLLINATIONS_TOKEN}"

        logger.info("[TASK] Fetching Pollinations image (auth=%s): %s",
                    "yes" if POLLINATIONS_TOKEN else "no", api_url[:120])

        last_status = None
        last_detail = ""
        for attempt in range(3):
            try:
                with httpx.Client(timeout=60, follow_redirects=True) as client:
                    resp = client.get(api_url, headers=headers)
                last_status = resp.status_code
                if resp.status_code == 200 and resp.content:
                    content_type = resp.headers.get("content-type", "")
                    if "image" in content_type or len(resp.content) > 1000:
                        logger.info("[TASK] Pollinations image fetched (%d bytes, %s)",
                                    len(resp.content), content_type or "unknown")
                        return (api_url, resp.content)
                    last_detail = f"non-image response (content-type={content_type!r}, {len(resp.content)} bytes)"
                else:
                    last_detail = (resp.text or "")[:200]
                logger.warning("[TASK] Pollinations attempt %d: status=%s %s",
                               attempt + 1, resp.status_code, last_detail)
                # Rate-limited → back off longer (Seed tier allows ~1 request / 5s).
                if resp.status_code == 429:
                    time.sleep(6)
                    continue
            except Exception as e:
                last_detail = str(e)
                logger.warning("[TASK] Pollinations attempt %d failed: %s", attempt + 1, e)
            time.sleep(2)

        # All attempts exhausted — raise with the real cause so it's visible, not guessed.
        if last_status == 429 or last_status is None:
            raise RuntimeError(
                "Image service is rate-limiting this server"
                + (f" (HTTP {last_status})" if last_status else " (no response)")
                + ". Set a free POLLINATIONS_TOKEN (auth.pollinations.ai) as an HF Space secret to fix this."
            )
        raise RuntimeError(f"Image service error (HTTP {last_status}): {last_detail or 'no image returned'}")

    def _do_content(self, payload: dict, chat_history: Optional[List[tuple]] = None) -> Optional[str]:
        prompt = (payload.get("prompt", payload.get("message", "")) or "").strip()
    
        if not prompt or not self.groq_service:
            return None
        content_question = f"Write the following. Be thorough and well-structured. Return only the requested content, no preamble.\n\n{prompt}"
    
        try:
            out = self.groq_service.get_response(
                question=content_question,
                chat_history=chat_history or [],
                key_start_index=0,
            )
        
            if not out or len(out.strip()) < 10:
                logger.warning("[TASK] Content generation returned empty or very short result")
                return None
            return out
        
        except Exception as e:
            logger.warning("[TASK] Content generation error: %s", e)
        return None
    

    def _do_google_search(self, payload: dict) -> Optional[str]:
        query = (payload.get("query", payload.get("message", "")) or "").strip()[:500]
        if not query:
            return None
        return f"https://www.google.com/search?q={quote(query, safe='')}"

    def _do_youtube_search(self, payload: dict) -> Optional[str]:
        query = (payload.get("query", payload.get("message", "")) or "").strip()[:500]
        if not query:
            return "https://www.youtube.com"
        return f"https://www.youtube.com/results?search_query={quote(query, safe='')}"