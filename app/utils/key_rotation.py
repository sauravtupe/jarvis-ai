import threading

_lock = threading.Lock()
_index = 0   # current key index

def get_next_key_pair(num_keys: int, need_brain: bool = True):
    global _index
    if not need_brain or num_keys == 0:
        return (None, 0)
    if num_keys == 1:
        return (0, 0)
    with _lock:
        chat_idx = _index % num_keys
        brain_idx = (chat_idx + 1) % num_keys
        _index += 1   # next call mein agle keys milenge
    return (brain_idx, chat_idx)

def advance_on_failure():
    """Jab koi key fail ho, isko call karo"""
    global _index
    with _lock:
        _index += 1