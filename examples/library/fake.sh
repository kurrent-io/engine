#!/bin/sh

set -e

show () {
    printf '\x1b[90m%s\x1b[m\n' "$*"
    "$@"
}

kurl () {
    method="$1"; shift
    path="$1"; shift
    show curl -LSs -u admin:changeit -D /dev/stderr -X $method "http://localhost:2113/${path#/}" \
        -H 'Content-Type: application/json' \
        -H 'Accept: application/json' \
        "$@"
    echo
}

event () {
    stream="$1"
    body="$2"
    kurl POST /streams/"$1" -H 'Kurrent-EventType: AnyType' -d "$body"
}

setup () {
    event "books" '{
        "type": "add-edition",
        "isbn": "isbn-1",
        "title": "cheech-and-chong-learn-event-sourcing",
        "timestamp": "2025-01-24T15:54:32Z"
    }'

    event "books" '{
        "type": "add-book",
        "isbn": "isbn-1",
        "id": "book-1",
        "restricted": false,
        "timestamp": "2025-01-24T15:54:32Z"
    }'

    event "patron.patron-1" '{
        "type": "add-patron",
        "id": "patron-1",
        "name": "joebob",
        "researcher": true,
        "timestamp": "2025-01-24T15:54:32Z"
    }'

    event "status" '{
        "type": "try-hold",
        "id": "hold-1",
        "patron": "patron-1",
        "target": {"book": "book-1"},
        "open": false,
        "timestamp": "2025-01-24T15:54:32Z"
    }'
}

read_stream () {
    stream="$1" ; shift
    kurl GET "/streams/$stream" "$@"
}

cmd="$1"; shift
case "$cmd" in
    setup) setup;;
    read) read_stream "$@";;
    *)
        echo "subcommands available are" >&2
        echo "  setup" >&2
        echo "  read STREAM" >&2
        exit 1;;
esac
