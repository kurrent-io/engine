#!/usr/bin/env python3
"""Dump all events from a KurrentDB stream to stdout as JSON."""

import json
import sys

import kurrentdbclient as kdbc

CONNSTR = "kurrentdb://admin:changeit@localhost:2113?tls=false"

def main():
    if len(sys.argv) < 2:
        print(f"usage: {sys.argv[0]} <stream-name>", file=sys.stderr)
        print(f"  use '$all' to read the $all stream", file=sys.stderr)
        sys.exit(1)

    stream = sys.argv[1]
    client = kdbc.KurrentDBClient(CONNSTR)

    if stream == "$all":
        reader = client.read_all(resolve_links=True)
    else:
        reader = client.read_stream(stream, resolve_links=True)

    with reader as events:
        for event in events:
            print(json.dumps({
                "stream": event.stream_name,
                "id": str(event.id),
                "type": event.type,
                "position": event.stream_position,
                "data": json.loads(event.data) if event.data else None,
            }))

if __name__ == "__main__":
    main()
