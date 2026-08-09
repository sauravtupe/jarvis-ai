"""Matcher tests for the AI-Teacher lecture commands (Phase C).

Guards the "no unnecessary questions" behaviour: a generic *"open the video lecture"*
must resume the class's current lesson and *"open the next lecture"* must advance —
across English (primary), Hindi and Marathi — without false-firing on ordinary prose.

Run standalone (no pytest needed):

    python tests/test_lecture_commands.py
"""

import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.services.lecture_service import (  # noqa: E402
    match_start_class_command,
    match_revision_command,
    match_assessment_command,
)

# (text, expected_action) — expected None means "must not be treated as a command"
START_CASES = [
    # English (primary language)
    ("start the lecture", "start"),
    ("start the class", "start"),
    ("open the lecture", "start"),
    ("open the video lecture", "start"),
    ("open the video", "start"),
    ("play the lecture", "start"),
    ("resume the lecture", "start"),
    ("continue the lecture", "start"),   # resume; resolve_target advances if complete
    ("launch the lecture", "start"),
    ("put on the lecture", "start"),
    ("jarvis start the lecture", "start"),
    ("begin today's lesson", "start"),
    # Explicit advancement
    ("next lecture", "next"),
    ("open the next lecture", "next"),
    ("next chapter", "next"),
    ("next lesson", "next"),
    ("advance to the next lecture", "next"),
    ("following lesson", "next"),
    # Hindi / Marathi
    ("लेक्चर सुरू कर", "start"),
    ("व्हिडिओ लेक्चर उघड", "start"),
    ("क्लास सुरू कर", "start"),
    ("लेक्चर लावा", "start"),
    ("वीडियो चालू करो", "start"),
    ("lecture chalu kara", "start"),
    ("पुढचं लेक्चर", "next"),
    ("अगला लेक्चर", "next"),
    ("पुढचा धडा", "next"),
    ("नेक्स्ट लेक्चर", "next"),
    # Must NOT fire
    ("open class 5 chapter 3", None),          # explicit chapter → match_lecture_command
    ("what is a class of algorithms in AI and how does it work in detail", None),
    ("tell me about the next generation of AI models please now", None),
    ("hello sir", None),
    ("", None),
]

REVISION_CASES = [
    ("revise chapter 1", 1),
    ("let us revise the lesson", None),      # None chapter → caller picks last completed
    ("उजळणी करूया", None),
    ("say that again please", "NO_MATCH"),
    ("start the class", "NO_MATCH"),
]

ASSESSMENT_CASES = [
    ("give us a quiz", "quiz"),
    ("give the class a worksheet", "worksheet"),
    ("assign homework", "homework"),
    ("what are the important questions", "important"),
    ("give me a summary of this lesson", "summary"),
    ("hello students", None),
]


def _run():
    failures = []

    for text, expected in START_CASES:
        got = match_start_class_command(text)
        action = got.get("action") if got else None
        if action != expected:
            failures.append(f"start_class({text!r}) -> {action!r}, expected {expected!r}")

    for text, expected in REVISION_CASES:
        got = match_revision_command(text)
        if expected == "NO_MATCH":
            if got is not None:
                failures.append(f"revision({text!r}) -> {got!r}, expected no match")
        elif got is None or got.get("chapter") != expected:
            failures.append(f"revision({text!r}) -> {got!r}, expected chapter={expected!r}")

    for text, expected in ASSESSMENT_CASES:
        got = match_assessment_command(text)
        kind = got.get("kind") if got else None
        if kind != expected:
            failures.append(f"assessment({text!r}) -> {kind!r}, expected {expected!r}")

    total = len(START_CASES) + len(REVISION_CASES) + len(ASSESSMENT_CASES)
    if failures:
        print(f"FAILED {len(failures)}/{total}")
        for f in failures:
            print("  -", f)
        return 1
    print(f"All {total} lecture-command matcher cases passed.")
    return 0


# pytest entry points (optional — the module also runs standalone)
def test_start_class_commands():
    for text, expected in START_CASES:
        got = match_start_class_command(text)
        assert (got.get("action") if got else None) == expected, text


def test_revision_commands():
    for text, expected in REVISION_CASES:
        got = match_revision_command(text)
        if expected == "NO_MATCH":
            assert got is None, text
        else:
            assert got is not None and got.get("chapter") == expected, text


def test_assessment_commands():
    for text, expected in ASSESSMENT_CASES:
        got = match_assessment_command(text)
        assert (got.get("kind") if got else None) == expected, text


if __name__ == "__main__":
    sys.exit(_run())
