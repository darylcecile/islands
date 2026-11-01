package islands

import (
	"context"
	"crypto/rand"
	"errors"
	"fmt"
	"strings"
	"sync"

	"github.com/tetratelabs/wazero"
	"github.com/tetratelabs/wazero/imports/wasi_snapshot_preview1"
)

// CallContext contains identity and metadata supplied by the embedding host.
// Each call receives its own metadata copy. Observe ctx cancellation in handlers.
type CallContext struct {
	ExtensionID string
	Metadata    map[string]any
}

type Handler func(ctx context.Context, input any, caller CallContext) (any, error)

type Options struct {
	Capabilities map[string]Handler
	Limits       Limits
}

type Runtime struct {
	engine       wazero.Runtime
	compiled     wazero.CompiledModule
	capabilities map[string]Handler
	limits       Limits
	mu           sync.Mutex
	closed       bool
	instances    map[string]*Extension
	loading      sync.WaitGroup
}

// New compiles the common dist/islands.wasm artifact once. WASI receives empty
// stdio/environment, clocks and entropy, with no filesystem preopens or sockets.
func New(ctx context.Context, wasm []byte, options Options) (*Runtime, error) {
	limits, err := options.Limits.defaults()
	if err != nil {
		return nil, err
	}
	capabilities := make(map[string]Handler, len(options.Capabilities))
	for name, handler := range options.Capabilities {
		if !validName(name) || handler == nil {
			return nil, failure("INVALID_CAPABILITY", "capabilities require valid names and non-nil handlers")
		}
		capabilities[name] = handler
	}
	engine := wazero.NewRuntimeWithConfig(ctx, wazero.NewRuntimeConfig().WithMemoryLimitPages(linearMemoryBytes/65536).WithCloseOnContextDone(true))
	compiled, err := engine.CompileModule(ctx, wasm)
	if err != nil {
		_ = engine.Close(ctx)
		return nil, wrap("ENGINE_ERROR", err)
	}
	for _, imported := range compiled.ImportedFunctions() {
		module, name, _ := imported.Import()
		if module != "wasi_snapshot_preview1" || strings.HasPrefix(name, "sock_") {
			_ = engine.Close(ctx)
			return nil, failure("UNSUPPORTED_IMPORT", module+"."+name)
		}
	}
	if len(compiled.ImportedMemories()) != 0 {
		_ = engine.Close(ctx)
		return nil, failure("UNSUPPORTED_IMPORT", "imported memory is not supported")
	}
	if _, err = wasi_snapshot_preview1.Instantiate(ctx, engine); err != nil {
		_ = engine.Close(ctx)
		return nil, wrap("ENGINE_ERROR", err)
	}
	return &Runtime{engine: engine, compiled: compiled, capabilities: capabilities, limits: limits, instances: map[string]*Extension{}}, nil
}

// Load checks required grants before executing any extension code, then awaits activation.
func (r *Runtime) Load(ctx context.Context, artifact Artifact, options LoadOptions) (*Extension, error) {
	if err := artifact.validate(); err != nil {
		return nil, err
	}
	if options.Policy != "" && options.Policy != "sandboxed" && options.Policy != "trusted" {
		return nil, failure("INVALID_POLICY", "policy must be sandboxed or trusted")
	}
	grants := make(map[string]bool)
	for _, name := range options.Grants {
		if !validName(name) {
			return nil, failure("INVALID_GRANT", "invalid capability grant")
		}
		grants[name] = true
	}
	if options.Policy == "trusted" {
		for name := range r.capabilities {
			grants[name] = true
		}
	}
	for _, name := range artifact.Manifest.Requires {
		if r.capabilities[name] == nil || !grants[name] {
			return nil, failure("CAPABILITY_REQUIRED", "required capability unavailable or ungranted: "+name)
		}
	}
	config, err := jsonCopy(options.Config)
	if err != nil {
		return nil, err
	}
	metadata, err := jsonCopy(options.Metadata)
	if err != nil {
		return nil, err
	}
	life, cancel := context.WithCancel(context.Background())
	e := &Extension{id: artifact.Manifest.ID, runtime: r, grants: grants, life: life, cancel: cancel, execution: make(chan struct{}, 1), pending: map[string]chan outcome{}, calls: map[string]*hostCall{}, retiredCalls: map[string]*hostCall{}, retiredOperations: map[string]bool{}, incoming: map[string]bool{}}
	if metadata != nil {
		e.metadata = metadata.(map[string]any)
	}
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		cancel()
		return nil, failure("DISPOSED", "runtime is disposed")
	}
	if _, exists := r.instances[e.id]; exists {
		r.mu.Unlock()
		cancel()
		return nil, failure("DUPLICATE_ID", "extension id is already loaded: "+e.id)
	}
	r.instances[e.id] = e
	r.loading.Add(1)
	r.mu.Unlock()
	defer r.loading.Done()
	ctx, stop := context.WithTimeout(ctx, r.limits.Timeout)
	defer stop()
	module, err := r.engine.InstantiateModule(ctx, r.compiled, wazero.NewModuleConfig().WithName("").WithStartFunctions().WithSysWalltime().WithSysNanotime().WithRandSource(rand.Reader))
	if err != nil {
		e.abort(wrap("ENGINE_ERROR", err))
		return nil, wrap("ENGINE_ERROR", err)
	}
	e.core = &core{module: module, limits: r.limits}
	if err = e.core.initialize(ctx, artifact.Code); err != nil {
		e.abort(err)
		return nil, err
	}
	if _, err = e.operation(ctx, map[string]any{"type": "activate", "config": config}); err != nil {
		e.abort(err)
		return nil, err
	}
	return e, nil
}

// Dispose attempts bounded guest cleanup for every instance and releases the engine.
func (r *Runtime) Dispose(ctx context.Context) error {
	r.mu.Lock()
	if r.closed {
		r.mu.Unlock()
		return nil
	}
	r.closed = true
	r.mu.Unlock()
	// Load itself is deadline-bounded; prevent teardown racing its module setup.
	r.loading.Wait()
	r.mu.Lock()
	instances := make([]*Extension, 0, len(r.instances))
	for _, e := range r.instances {
		instances = append(instances, e)
	}
	r.mu.Unlock()
	errs := make(chan error, len(instances))
	for _, e := range instances {
		go func() { errs <- e.Dispose(ctx) }()
	}
	var result error
	for range instances {
		result = errors.Join(result, <-errs)
	}
	return errors.Join(result, r.engine.Close(context.Background()))
}

type outcome struct {
	value any
	err   error
}

type hostCall struct {
	cancel     context.CancelFunc
	generation uint64
}

type Extension struct {
	id                string
	runtime           *Runtime
	core              *core
	grants            map[string]bool
	metadata          map[string]any
	life              context.Context
	cancel            context.CancelFunc
	execution         chan struct{}
	mu                sync.Mutex
	closed            bool
	disposing         bool
	disposeDone       chan struct{}
	disposeErr        error
	generation        uint64
	sequence          uint64
	pending           map[string]chan outcome
	calls             map[string]*hostCall
	retiredCalls      map[string]*hostCall
	retiredOperations map[string]bool
	incoming          map[string]bool
}

func (e *Extension) ID() string { return e.id }

func (e *Extension) Invoke(ctx context.Context, method string, input any) (any, error) {
	if !validName(method) {
		return nil, failure("INVALID_METHOD", "method must be a nonempty string of at most 1024 bytes")
	}
	value, err := jsonCopy(input)
	if err != nil {
		return nil, err
	}
	return e.operation(ctx, map[string]any{"type": "invoke", "method": method, "input": value})
}

func (e *Extension) Emit(ctx context.Context, event string, payload any) error {
	if !validName(event) {
		return failure("INVALID_EVENT", "event must be a nonempty string of at most 1024 bytes")
	}
	value, err := jsonCopy(payload)
	if err != nil {
		return err
	}
	_, err = e.operation(ctx, map[string]any{"type": "event", "event": event, "payload": value})
	return err
}

func (e *Extension) Dispose(ctx context.Context) error {
	e.mu.Lock()
	if e.disposeDone != nil {
		done := e.disposeDone
		e.mu.Unlock()
		select {
		case <-done:
			e.mu.Lock()
			err := e.disposeErr
			e.mu.Unlock()
			return err
		case <-ctx.Done():
			return contextError(ctx.Err())
		}
	}
	if e.closed {
		e.mu.Unlock()
		return nil
	}
	e.disposing = true
	e.disposeDone = make(chan struct{})
	e.generation++
	for id, call := range e.calls {
		e.retiredCalls[id] = call
		call.cancel()
	}
	e.calls = map[string]*hostCall{}
	e.incoming = map[string]bool{}
	for id, pending := range e.pending {
		pending <- outcome{err: failure("DISPOSED", "extension is disposing")}
		e.retiredOperations[id] = true
		delete(e.pending, id)
	}
	e.mu.Unlock()
	_, err := e.operation(ctx, map[string]any{"type": "dispose"})
	err = errors.Join(err, e.shutdown(failure("DISPOSED", "extension is disposed"), err == nil, nil))
	e.mu.Lock()
	e.disposeErr = err
	close(e.disposeDone)
	e.mu.Unlock()
	return err
}

func contextError(err error) *Error {
	if errors.Is(err, context.DeadlineExceeded) {
		return wrap("TIMEOUT", err)
	}
	return wrap("CANCELLED", err)
}

func (e *Extension) operation(ctx context.Context, message map[string]any) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, e.runtime.limits.Timeout)
	defer cancel()
	if ctx.Err() != nil {
		return nil, contextError(ctx.Err())
	}
	e.mu.Lock()
	if e.closed || (e.disposing && message["type"] != "dispose") {
		e.mu.Unlock()
		return nil, failure("DISPOSED", "extension is disposed")
	}
	generation := e.generation
	e.sequence++
	id := fmt.Sprintf("h%d", e.sequence)
	result := make(chan outcome, 1)
	e.pending[id] = result
	e.mu.Unlock()
	message["id"] = id
	defer func() { e.mu.Lock(); delete(e.pending, id); e.mu.Unlock() }()
	if _, err := encodeMessage(message); err != nil {
		return nil, err
	}
	if err := e.deliver(ctx, message, generation); err != nil {
		e.abortCurrent(generation, err)
		return nil, err
	}
	select {
	case value := <-result:
		return value.value, value.err
	case <-ctx.Done():
		err := contextError(ctx.Err())
		e.abortCurrent(generation, err)
		return nil, err
	case <-e.life.Done():
		select {
		case value := <-result:
			return value.value, value.err
		default:
			return nil, failure("DISPOSED", "extension is disposed")
		}
	}
}

func (e *Extension) exchange(ctx context.Context, message map[string]any, generation uint64) ([]wireMessage, error) {
	select {
	case e.execution <- struct{}{}:
		defer func() { <-e.execution }()
	case <-e.life.Done():
		return nil, failure("DISPOSED", "extension is disposed")
	case <-ctx.Done():
		return nil, contextError(ctx.Err())
	}
	if e.life.Err() != nil {
		return nil, failure("DISPOSED", "extension is disposed")
	}
	e.mu.Lock()
	current := generation == e.generation
	e.mu.Unlock()
	if !current {
		return nil, nil
	}
	messages, err := e.core.exchange(ctx, message)
	if err != nil {
		return nil, err
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed || generation != e.generation {
		return nil, nil
	}
	if message["type"] == "result" {
		delete(e.incoming, message["id"].(string))
	}
	// Reserve all output IDs in wire order before releasing the execution gate
	// or starting callbacks. Quota slots have a separate, shorter lifetime.
	for _, outgoing := range messages {
		if outgoing.Type != "call" {
			continue
		}
		if e.incoming[outgoing.ID] || e.calls[outgoing.ID] != nil || e.retiredCalls[outgoing.ID] != nil {
			return nil, failure("PROTOCOL_ERROR", "duplicate outstanding host call id: "+outgoing.ID)
		}
		e.incoming[outgoing.ID] = true
	}
	return messages, nil
}

func (e *Extension) deliver(ctx context.Context, message map[string]any, generation uint64) error {
	queue := []map[string]any{message}
	for len(queue) != 0 {
		messages, err := e.exchange(ctx, queue[0], generation)
		if err != nil {
			return err
		}
		queue = queue[1:]
		for _, m := range messages {
			if m.Type == "result" {
				if err := e.receiveResult(m); err != nil {
					return err
				}
			} else if response, err := e.startCall(ctx, m, generation); err != nil {
				return err
			} else if response != nil {
				queue = append(queue, response)
			}
		}
	}
	return nil
}

func (e *Extension) receiveResult(m wireMessage) error {
	var value any
	if m.OK != nil && *m.OK {
		var err error
		value, err = decodeJSON(m.Value)
		if err != nil {
			return err
		}
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed {
		return nil
	}
	if e.retiredOperations[m.ID] {
		delete(e.retiredOperations, m.ID)
		return nil
	}
	result, ok := e.pending[m.ID]
	if !ok {
		return failure("PROTOCOL_ERROR", "unknown or duplicate operation result: "+m.ID)
	}
	delete(e.pending, m.ID)
	var err error
	if !*m.OK {
		err = failure(m.Error.Code, *m.Error.Message)
	}
	result <- outcome{value, err}
	return nil
}

func (e *Extension) startCall(parent context.Context, m wireMessage, generation uint64) (map[string]any, error) {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.closed || generation != e.generation {
		return nil, nil
	}
	if e.calls[m.ID] != nil || e.retiredCalls[m.ID] != nil {
		return nil, failure("PROTOCOL_ERROR", "duplicate unsettled host call id: "+m.ID)
	}
	if !e.grants[m.Method] {
		return errorEnvelope(m.ID, failure("CAPABILITY_DENIED", "capability not granted: "+m.Method)), nil
	}
	handler := e.runtime.capabilities[m.Method]
	if handler == nil {
		return errorEnvelope(m.ID, failure("CAPABILITY_NOT_FOUND", "capability unavailable: "+m.Method)), nil
	}
	if len(e.calls) >= e.runtime.limits.MaxPendingCalls {
		return errorEnvelope(m.ID, failure("TOO_MANY_CALLS", "pending host call limit reached")), nil
	}
	input, err := decodeJSON(m.Input)
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(parent), e.runtime.limits.Timeout)
	stop := context.AfterFunc(e.life, cancel)
	call := &hostCall{cancel: cancel, generation: generation}
	e.calls[m.ID] = call
	go func() {
		defer cancel()
		defer stop()
		metadata, err := jsonCopy(e.metadata)
		caller := CallContext{ExtensionID: e.id}
		if metadata != nil {
			caller.Metadata = metadata.(map[string]any)
		}
		var value any
		if err == nil {
			value, err = runHandler(ctx, handler, input, caller)
		}
		if err == nil {
			value, err = jsonCopy(value)
		}
		if err == nil && ctx.Err() != nil {
			err = contextError(ctx.Err())
		}
		response := map[string]any{"type": "result", "id": m.ID, "ok": true, "value": value}
		if err != nil {
			response = errorEnvelope(m.ID, err)
		}
		if _, err := encodeMessage(response); err != nil {
			response = errorEnvelope(m.ID, err)
		}
		e.mu.Lock()
		if e.calls[m.ID] == call {
			delete(e.calls, m.ID)
		}
		if e.retiredCalls[m.ID] == call {
			delete(e.retiredCalls, m.ID)
		}
		current := !e.closed && e.generation == call.generation
		e.mu.Unlock()
		if !current {
			return
		}
		// A timed-out callback still needs a fresh bounded turn to reject its guest Promise.
		delivery, done := context.WithTimeout(e.life, e.runtime.limits.Timeout)
		defer done()
		if err := e.deliver(delivery, response, call.generation); err != nil {
			e.abortCurrent(call.generation, err)
		}
	}()
	return nil, nil
}

func runHandler(ctx context.Context, handler Handler, input any, caller CallContext) (value any, err error) {
	defer func() {
		if recovered := recover(); recovered != nil {
			err = failure("HOST_ERROR", fmt.Sprintf("capability panic: %v", recovered))
		}
	}()
	return handler(ctx, input, caller)
}

func (e *Extension) abort(reason error) {
	_ = e.shutdown(reason, false, nil)
}

func (e *Extension) abortCurrent(generation uint64, reason error) {
	_ = e.shutdown(reason, false, &generation)
}

func (e *Extension) shutdown(reason error, clean bool, generation *uint64) error {
	e.mu.Lock()
	if e.closed || (generation != nil && *generation != e.generation) {
		e.mu.Unlock()
		return nil
	}
	e.closed = true
	e.generation++
	e.cancel()
	for _, call := range e.calls {
		call.cancel()
	}
	for _, call := range e.retiredCalls {
		call.cancel()
	}
	for id, pending := range e.pending {
		pending <- outcome{err: reason}
		delete(e.pending, id)
	}
	e.mu.Unlock()
	var err error
	if e.core != nil {
		if clean {
			ctx, cancel := context.WithTimeout(context.Background(), e.runtime.limits.Timeout)
			select {
			case e.execution <- struct{}{}:
				if e.core.trap == nil {
					_, err = e.core.call(ctx, "islands_destroy")
				}
				<-e.execution
			case <-ctx.Done():
				err = contextError(ctx.Err())
			}
			cancel()
		}
		// Closing wazero interrupts in-flight code without waiting for host callbacks.
		err = errors.Join(err, e.core.module.Close(context.Background()))
	}
	e.runtime.mu.Lock()
	delete(e.runtime.instances, e.id)
	e.runtime.mu.Unlock()
	return err
}
