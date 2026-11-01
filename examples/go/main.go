package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"sync"
	"time"

	islands "github.com/darylcecile/islands/sdk/go"
)

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func run() error {
	root := "../.."
	if len(os.Args) > 1 {
		root = os.Args[1]
	}
	wasm, err := os.ReadFile(filepath.Join(root, "dist/islands.wasm"))
	if err != nil {
		return err
	}
	data, err := os.ReadFile(filepath.Join(root, "dist/extensions/portable-greeter.json"))
	if err != nil {
		return err
	}
	artifact, err := islands.ParseArtifact(data)
	if err != nil {
		return err
	}
	ctx := context.Background()
	var mu sync.Mutex
	var logs []string
	runtime, err := islands.New(ctx, wasm, islands.Options{Capabilities: map[string]islands.Handler{
		"log.write": func(ctx context.Context, input any, caller islands.CallContext) (any, error) {
			if caller.ExtensionID != artifact.Manifest.ID || caller.Metadata["workspaceId"] != "native-demo" {
				return nil, fmt.Errorf("incorrect host-bound caller context: %+v", caller)
			}
			body, ok := input.(map[string]any)
			if !ok {
				return nil, fmt.Errorf("log.write expects an object")
			}
			message, ok := body["message"].(string)
			if !ok {
				return nil, fmt.Errorf("log.write expects a string message")
			}
			select {
			case <-time.After(time.Millisecond):
			case <-ctx.Done():
				return nil, ctx.Err()
			}
			mu.Lock()
			logs = append(logs, message)
			mu.Unlock()
			return nil, nil
		},
	}})
	if err != nil {
		return err
	}
	defer runtime.Dispose(ctx)
	extension, err := runtime.Load(ctx, artifact, islands.LoadOptions{Grants: []string{"log.write"}, Metadata: map[string]any{"workspaceId": "native-demo"}})
	if err != nil {
		return err
	}
	for calls := 1; calls <= 2; calls++ {
		result, err := extension.Invoke(ctx, "greet", map[string]any{"name": "Islands"})
		if err != nil {
			return err
		}
		expected := map[string]any{"message": "Hello, Islands!", "calls": float64(calls)}
		if !reflect.DeepEqual(result, expected) {
			return fmt.Errorf("greet returned %#v, expected %#v", result, expected)
		}
	}
	if err := extension.Emit(ctx, "native.example", nil); err != nil {
		return err
	}
	mu.Lock()
	matched := reflect.DeepEqual(logs, []string{"Hello, Islands!", "Hello, Islands!"})
	mu.Unlock()
	if !matched {
		return fmt.Errorf("unexpected host log calls: %v", logs)
	}
	if err := extension.Dispose(ctx); err != nil {
		return err
	}
	if err := runtime.Dispose(ctx); err != nil {
		return err
	}
	fmt.Println("Go: portable-greeter returned two greetings (calls 1, 2); async host logging, metadata, emit and dispose passed")
	return nil
}
