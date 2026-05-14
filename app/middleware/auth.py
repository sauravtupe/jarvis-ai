import logging
from fastapi import Depends, HTTPException
from fastapi.security import HTTPBearer, HTTPAuthorizationCredentials
from jose import jwt, JWTError
from config import JWT_SECRET_KEY

logger = logging.getLogger(__name__)

_security = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials = Depends(_security),
) -> str:
    """Validate Supabase JWT and return user UUID. Raises 401 on failure."""
    if not credentials:
        raise HTTPException(status_code=401, detail="Authentication required.")
    try:
        payload = jwt.decode(
            credentials.credentials,
            JWT_SECRET_KEY,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
        user_id: str = payload.get("sub", "")
        if not user_id:
            raise HTTPException(status_code=401, detail="Token missing subject claim.")
        return user_id
    except JWTError as exc:
        logger.warning("[AUTH] JWT validation failed: %s", exc)
        raise HTTPException(status_code=401, detail="Invalid or expired token.")


async def get_optional_user(
    credentials: HTTPAuthorizationCredentials = Depends(_security),
) -> str:
    """Return user UUID from JWT if valid, otherwise 'anonymous'."""
    if not credentials:
        return "anonymous"
    try:
        payload = jwt.decode(
            credentials.credentials,
            JWT_SECRET_KEY,
            algorithms=["HS256"],
            options={"verify_aud": False},
        )
        return payload.get("sub") or "anonymous"
    except JWTError:
        return "anonymous"
