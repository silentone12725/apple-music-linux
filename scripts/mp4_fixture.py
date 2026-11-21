"""Derive a malformed fragmented-MP4 test fixture: only the final sample duration changes."""
import struct

CONTAINERS = {b'moof', b'traf'}


def boxes(data, start, end):
    pos = start
    while pos + 8 <= end:
        size, kind = struct.unpack_from('>I4s', data, pos)
        header = 8
        if size == 1:
            size, header = struct.unpack_from('>Q', data, pos + 8)[0], 16
        elif size == 0:
            size = end - pos
        if size < header or pos + size > end:
            raise ValueError(f'invalid {kind!r} box at {pos}')
        yield kind, pos + header, pos + size
        if kind in CONTAINERS:
            yield from boxes(data, pos + header, pos + size)
        pos += size


def set_final_duration(data, duration):
    """Return a copy with the last trun's last sample duration replaced."""
    data = bytearray(data)
    truns = [body for kind, body, _ in boxes(data, 0, len(data)) if kind == b'trun']
    if not truns:
        raise ValueError('no fragment trun box')
    body = truns[-1]
    flags = int.from_bytes(data[body + 1:body + 4], 'big')
    if not flags & 0x100:
        raise ValueError('final trun has no per-sample durations')
    count = struct.unpack_from('>I', data, body + 4)[0]
    if not count:
        raise ValueError('final trun is empty')
    first = body + 8 + (4 if flags & 0x1 else 0) + (4 if flags & 0x4 else 0)
    entry = 4 * sum(bool(flags & bit) for bit in (0x100, 0x200, 0x400, 0x800))
    struct.pack_into('>I', data, first + (count - 1) * entry, duration)
    return bytes(data)
