

from datetime import datetime, timezone, timedelta


_IST = timezone(timedelta(hours=5, minutes=30))


def get_time_information() -> str:
    now = datetime.now(_IST)
    return now.strftime("%A, %B %d, %I:%M %p IST")
