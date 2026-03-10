package main

import (
	"fmt"
	"os"
	_ "embed"

	"github.com/dop251/goja"

	"github.com/kurrent-io/engine/go/model"
)

//go:embed decider.js
var deciderScript string

type Book struct {
	Title string
	Copies int
}

func run() error {
	fw, err := model.NewDeciderFramework[any](
		deciderScript,
		model.NewInMemStorage(),
		"DecodeLibraryEvents",
		"deciderShaper",
		"deciderProjector",
	)
	if err != nil {
		return fmt.Errorf("creating framework: %w", err)
	}

	// create a query
	bookList := model.NewQuery(fw, func(vm *goja.Runtime, qx model.DeciderQueryContext, prev *[]Book) []Book {
		var out []Book
		for isbn := range qx.Editions() {
			edition := qx.Edition(isbn)
			out = append(out, Book{ edition.Title(vm), len(edition.Books(vm)) })
		}
		return out
	})

	// subscribe to the output of the query
	bookList.Subscribe(func(books[]Book) {
		fmt.Printf("have books:\n")
		for _, book := range books {
			fmt.Printf("  - %v (x%v)\n", book.Title, book.Copies)
		}
	})

	// create an event
	event := fw.VM().ToValue(map[string]any{
		"type": "add-edition",
		"isbn": "my-isbn",
		"title": "cheech-and-chong-learn-event-sourcing",
		"timestamp": "2025-01-24T15:54:32Z",
	})

	// invoke the generated checker
	err = model.CheckLibraryEvents(event, "event")
	if err != nil {
		return err
	}

	// feed event to framework
	fw.RecvEvents(fw.VM().ToValue([]goja.Value{event}))
	err = fw.Run()
	if err != nil {
		return err
	}

	// feed another event to framework
	event = fw.VM().ToValue(map[string]any{
		"type": "add-edition",
		"isbn": "my-isbn-2",
		"title": "everyone-else-learns-event-sourcing",
		"timestamp": "2025-01-24T15:54:32Z",
	})
	fw.RecvEvents(fw.VM().ToValue([]goja.Value{event}))
	err = fw.Run()
	if err != nil {
		return err
	}

	return nil
}

func main() {
	err := run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "fail: %v\n", err)
		os.Exit(1)
	}
}
