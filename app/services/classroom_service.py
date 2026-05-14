import json
import logging
import re

logger = logging.getLogger(__name__)

_PROMPT = (
    "Count every person visible in this image — regardless of the setting (home, office, classroom, anywhere).\n"
    "For EACH person you can see:\n"
    "  - Assign a position label (e.g. center, left, right, front-left, back-right, etc.)\n"
    "  - Rate their attention/focus level 1-10 (are they looking at the camera/screen/front? "
    "Are they engaged or looking away/distracted?)\n"
    "  - status: 'attentive' if attention >= 6, else 'distracted'\n"
    "Then compute:\n"
    "  attentive_count  = count of attentive people\n"
    "  distracted_count = count of distracted people\n"
    "  total_visible    = attentive_count + distracted_count\n"
    "  overall_attention_percent = round(attentive_count / total_visible * 100), or 0 if total_visible is 0\n"
    "IMPORTANT: Report every face/person you can see. Do not skip anyone.\n"
    "Return ONLY this JSON, no other text:\n"
    '{"overall_attention_percent":<int>,"attentive_count":<int>,'
    '"distracted_count":<int>,"total_visible":<int>,'
    '"students":[{"position":"<str>","attention 1-10":<int>,"status":"attentive"}]}'
)


def analyse_frame(frame_base64: str, openai_api_key: str) -> dict:
    from openai import OpenAI

    client = OpenAI(api_key=openai_api_key)

    response = client.chat.completions.create(
        model="gpt-4o",
        messages=[
            {
                "role": "user",
                "content": [
                    {
                        "type": "image_url",
                        "image_url": {
                            "url": f"data:image/jpeg;base64,{frame_base64}",
                            "detail": "auto",
                        },
                    },
                    {"type": "text", "text": _PROMPT},
                ],
            }
        ],
        max_tokens=1500,
    )

    raw = (response.choices[0].message.content or "").strip()
    logger.info("[CLASSROOM] Raw GPT-4o response: %s", raw[:500])
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```$", "", raw, flags=re.MULTILINE).strip()

    try:
        result = json.loads(raw)
    except json.JSONDecodeError:
        m = re.search(r"\{.*\}", raw, re.DOTALL)
        if m:
            result = json.loads(m.group(0))
        else:
            logger.error("[CLASSROOM] Failed to parse JSON. Full response: %s", raw[:1000])
            raise ValueError(f"Could not parse classroom JSON from GPT-4o response: {raw[:200]}")

    logger.info(
        "[CLASSROOM] Analysed: %d total, %d attentive, %d distracted, attention=%s%%",
        result.get("total_visible", 0),
        result.get("attentive_count", 0),
        result.get("distracted_count", 0),
        result.get("overall_attention_percent", "?"),
    )
    return result
