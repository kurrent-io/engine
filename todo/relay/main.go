package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"

	"github.com/dop251/goja"
	"github.com/google/uuid"
	"github.com/gorilla/websocket"
	"github.com/kurrent-io/KurrentDB-Client-Go/kurrentdb"
	"golang.org/x/sync/errgroup"

	"github.com/kurrent-io/engine/todo/relay/model"
)

/* For this demo, we'll assume:
	 - non-tls connection to kurrentdb running on local host, with default creds
	 - all events in a single stream (since we don't have users anyway) */
const (
	connstr    = "kurrentdb://admin:changeit@127.0.0.1:2113?tls=false"
	todoStream = "todo"
	eventType  = "TodoEvents"
	listenAddr = ":3003"
)

// Command is the {id, data} envelope clients send for each new event.
type Command struct {
	ID   uuid.UUID       `json:"id"`
	Data json.RawMessage `json:"data"`
}

// Handshake is the first message a client sends after the websocket opens.
type Handshake struct {
	Since *uint64 `json:"since"`
}

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool { return true },
}

func handle(
	baseCtx context.Context, w http.ResponseWriter, r *http.Request, client *kurrentdb.Client,
) error {
	ws, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		return err
	}
	defer ws.Close()

	// 1. read handshake
	_, raw, err := ws.ReadMessage()
	if err != nil {
		return fmt.Errorf("invalid handshake: %w", err)
	}
	var hs Handshake
	if err := json.Unmarshal(raw, &hs); err != nil {
		return fmt.Errorf("bad handshake: %w", err)
	}

	g, ctx := errgroup.WithContext(baseCtx)

	// 2. subscribe to the todo stream from `since` (catchup + live in one call)
	var from kurrentdb.AllPosition = kurrentdb.Start{}
	if hs.Since != nil {
		from = kurrentdb.Position{Commit: *hs.Since, Prepare: *hs.Since}
	}
	sub, err := client.SubscribeToAll(ctx, kurrentdb.SubscribeToAllOptions{
		From: from,
		Filter: &kurrentdb.SubscriptionFilter{
			Type:     kurrentdb.StreamFilterType,
			Prefixes: []string{todoStream},
		},
		CheckpointInterval: 1000,
	})
	if err != nil {
		return fmt.Errorf("subscribe: %w", err)
	}
	defer sub.Close()

	// 3. forward subscription events to the websocket
	g.Go(func() error {
		for {
			ev := sub.Recv()
			switch {
			case ev.SubscriptionDropped != nil:
				return fmt.Errorf("subscription dropped: %w", ev.SubscriptionDropped.Error)
			case ev.CaughtUp != nil:
				if err := ws.WriteMessage(websocket.TextMessage, []byte(`caughtup`)); err != nil {
					return fmt.Errorf("writing to websocket: %w", err)
				}
			case ev.EventAppeared != nil:
				rec := ev.EventAppeared.Event
				// dedupe: KurrentDB redelivers the event at `since` itself
				if hs.Since != nil && rec.Position.Commit == *hs.Since {
					continue
				}
				wire := fmt.Sprintf(
					`{"position":%d,"id":"%s","data":%s}`,
					rec.Position.Commit, rec.EventID.String(), string(rec.Data),
				)
				if err := ws.WriteMessage(websocket.TextMessage, []byte(wire)); err != nil {
					return fmt.Errorf("writing to websocket: %w", err)
				}
			}
		}
	})

	// 4. receive commands from the websocket; validate + append, or close on bad input
	g.Go(func() error {
		// cancel ws.ReadMessage() if our subscription dies
		go func() {
			<-ctx.Done()
			ws.Close()
		}()

		// configure a JS vm to do the validation
		/* Note: it feels silly to use javascript to do validation in this demo but in production
		   code, you'll usually reuse parts of your reducer code to thoroughly validate user inputs,
		   so unmarshalling directly into javascript unlocks that capability */
		vm := goja.New()
		for {
			_, raw, err := ws.ReadMessage()
			if err != nil {
				return fmt.Errorf("reading from websocket: %w", err)
			}

			// unmarshal command wrapper into native go
			var cmd Command
			err = json.Unmarshal(raw, &cmd)
			if err != nil {
				return fmt.Errorf("invalid command: %w", err)
			}

			// unmarshal command itself into goja object
			value, err := model.JSONToGoja(vm, cmd.Data)
			if err != nil {
				return fmt.Errorf("invalid command: %w", err)
			}

			// check goja object for validity
			err = model.CheckTodoEvents(vm, value, "")
			if err != nil {
				return fmt.Errorf("invalid command: %w", err)
			}

			// append event to stream
			_, err = client.AppendToStream(ctx, todoStream,
				kurrentdb.AppendToStreamOptions{},
				kurrentdb.EventData{
					EventID:     cmd.ID,
					EventType:   eventType,
					ContentType: kurrentdb.ContentTypeJson,
					Data:        cmd.Data,
				},
			)
			if err != nil {
				return fmt.Errorf("append: %w", err)
			}
		}
	})

	return g.Wait()
}

func main() {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	cfg, err := kurrentdb.ParseConnectionString(connstr)
	if err != nil {
		log.Fatalf("parse connstr: %v", err)
	}
	client, err := kurrentdb.NewClient(cfg)
	if err != nil {
		log.Fatalf("kurrentdb client: %v", err)
	}
	defer client.Close()

	http.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		err := handle(ctx, w, r, client)
		if err != nil {
			fmt.Fprintf(os.Stderr, "client error: %v\n", err)
		}
	})

	log.Printf("listening on %s", listenAddr)
	if err := http.ListenAndServe(listenAddr, nil); err != nil {
		log.Fatalf("listen: %v", err)
	}
}
