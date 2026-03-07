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

	event := fw.VM().ToValue(map[string]any{
		"type": "add-edition",
		"isbn": "my-isbn",
		"title": "cheech-and-chong-learn-event-sourcing",
		"timestamp": "2025-01-24T15:54:32Z",
	})

	err = model.CheckLibraryEvents(event, "event")
	if err != nil {
		return err
	}

	bookList := model.NewQuery(fw, func(vm *goja.Runtime, qx model.DeciderQueryContext, prev *[]Book) []Book {
		var out []Book
		for isbn := range qx.Editions() {
			edition := qx.Edition(isbn)
			out = append(out, Book{ edition.Title(vm), len(edition.Books(vm)) })
		}
		return out
	})

	bookList.Subscribe(func(books[]Book) {
		fmt.Printf("have books:\n")
		for _, book := range books {
			fmt.Printf("  - %v (x%v)\n", book.Title, book.Copies)
		}
	})

	fw.Run()

	return nil
}

func main() {
	err := run()
	if err != nil {
		fmt.Fprintf(os.Stderr, "fail: %v\n", err)
		os.Exit(1)
	}
}
