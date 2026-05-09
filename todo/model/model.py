"""
A simple sync engine example: a collaborative to-do list.
"""

from protos import (
    Alias,
    Array,
    Bool,
    Literal,
    Store,
    String,
    Struct,
    Union,
    Framework,
)

def Enum(*strings):
    return Union(*(Literal(s) for s in strings))

###################
## Storage Layer ##
###################

Uuid = Alias(String)

List = Struct(
    id=Uuid,
    name=String,
    items=Array(Uuid),  # array of item ids
    archived=Bool,
)

Item = Struct(
    id=Uuid,
    text=String,
    done=Bool,
    archived=Bool,
)

TodoStore = Store({
    "all_lists": Array(Uuid),  # array of list ids
    "list.{list_id}": List,
    "item.{item_id}": Item,
})

##################
## Events Layer ##
##################

NewList = Struct(
    type=Literal("new-list"),
    id=Uuid,
    name=String,
)

RenameList = Struct(
    type=Literal("rename-list"),
    id=Uuid,
    name=String,
)

ArchiveList = Struct(
    type=Literal("archive-list"),
    id=Uuid,
)

NewItem = Struct(
    type=Literal("new-item"),
    id=Uuid,
    list=Uuid,
    text=String,
)

EditItem = Struct(
    type=Literal("edit-item"),
    id=Uuid,
    text=String,
)

MarkItem = Struct(
    type=Literal("mark-item"),
    id=Uuid,
    done=Bool,
)

ArchiveItem = Struct(
    type=Literal("archive-item"),
    id=Uuid,
)

TodoEvents = NewList | RenameList | ArchiveList | NewItem | EditItem | MarkItem | ArchiveItem

TodoFramework = Framework(TodoEvents, TodoEvents, TodoStore)
