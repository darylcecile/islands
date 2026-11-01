package islands

import (
	"context"
	"fmt"
	"strings"

	"github.com/tetratelabs/wazero/api"
)

// core is only accessed while holding Extension.execution. No host callback
// executes under that gate, and all guest-owned buffers are copied before reentry.
type core struct {
	module api.Module
	limits Limits
	trap   error
}

func (c *core) call(ctx context.Context, name string, args ...uint64) (uint32, error) {
	if c.trap != nil {
		return 0, c.trap
	}
	fn := c.module.ExportedFunction(name)
	if fn == nil {
		return 0, failure("ABI_MISMATCH", "missing export: "+name)
	}
	values, err := fn.Call(ctx, args...)
	if err != nil {
		c.trap = wrap("ENGINE_ERROR", err)
		if ctx.Err() != nil {
			c.trap = contextError(ctx.Err())
		}
		return 0, c.trap
	}
	if len(values) == 0 {
		return 0, nil
	}
	return uint32(values[0]), nil
}

func (c *core) buffer(ctx context.Context, prefix string, limit uint32) ([]byte, error) {
	ptr, err := c.call(ctx, prefix+"_ptr")
	if err != nil {
		return nil, err
	}
	length, err := c.call(ctx, prefix+"_len")
	if err != nil {
		return nil, err
	}
	if length > limit {
		return nil, failure("PROTOCOL_ERROR", "core buffer exceeds limit")
	}
	if length == 0 {
		return nil, nil
	}
	memory := c.module.Memory()
	if memory == nil {
		return nil, failure("ABI_MISMATCH", "missing linear memory")
	}
	view, ok := memory.Read(ptr, length)
	if !ok {
		return nil, failure("PROTOCOL_ERROR", "core buffer is outside linear memory")
	}
	return append([]byte(nil), view...), nil
}

func (c *core) status(ctx context.Context, status uint32) error {
	if int32(status) >= 0 {
		return nil
	}
	data, err := c.buffer(ctx, "islands_error", maxMessageBytes)
	if err != nil {
		return err
	}
	message := string(data)
	code := "ENGINE_ERROR"
	if strings.Contains(strings.ToLower(message), "fuel") || strings.Contains(strings.ToLower(message), "interrupt") {
		code = "FUEL_EXHAUSTED"
	} else if strings.Contains(strings.ToLower(message), "heap") || strings.Contains(strings.ToLower(message), "memory exhausted") {
		code = "MEMORY_LIMIT"
	}
	if message == "" {
		message = "core operation failed"
	}
	return failure(code, message)
}

func (c *core) input(ctx context.Context, export string, data []byte) (err error) {
	ptr, err := c.call(ctx, "islands_alloc", uint64(len(data)))
	if err != nil {
		return err
	}
	if ptr == 0 {
		return failure("MEMORY_LIMIT", "core input allocation failed")
	}
	defer func() {
		if c.trap != nil {
			return
		}
		_, freeErr := c.call(ctx, "islands_free", uint64(ptr))
		if err == nil {
			err = freeErr
		}
	}()
	if c.module.Memory() == nil || !c.module.Memory().Write(ptr, data) {
		return failure("PROTOCOL_ERROR", "input allocation outside linear memory")
	}
	status, err := c.call(ctx, export, uint64(ptr), uint64(len(data)), uint64(c.limits.Fuel))
	if err != nil {
		return err
	}
	return c.status(ctx, status)
}

func (c *core) initialize(ctx context.Context, code string) error {
	if _, err := c.call(ctx, "_initialize"); err != nil {
		return err
	}
	version, err := c.call(ctx, "islands_abi_version")
	if err != nil {
		return err
	}
	if version != 1 {
		return failure("ABI_MISMATCH", fmt.Sprintf("expected ABI 1, received %d", version))
	}
	status, err := c.call(ctx, "islands_init", uint64(c.limits.MemoryBytes), uint64(c.limits.StackBytes))
	if err != nil {
		return err
	}
	if err = c.status(ctx, status); err != nil {
		return err
	}
	return c.input(ctx, "islands_eval", []byte(code))
}

func (c *core) exchange(ctx context.Context, message map[string]any) ([]wireMessage, error) {
	data, err := encodeMessage(message)
	if err != nil {
		return nil, err
	}
	if err = c.input(ctx, "islands_dispatch", data); err != nil {
		return nil, err
	}
	var messages []wireMessage
	totalBytes := 0
	for {
		if err := ctx.Err(); err != nil {
			return nil, contextError(err)
		}
		data, err := c.buffer(ctx, "islands_output", maxMessageBytes)
		if err != nil {
			return nil, err
		}
		totalBytes += len(data)
		if totalBytes > maxMessageBytes {
			return nil, failure("PROTOCOL_ERROR", "one job drain produced more than 1 MiB of messages")
		}
		if _, err = c.call(ctx, "islands_output_clear"); err != nil {
			return nil, err
		}
		batch, err := decodeMessages(data)
		if err != nil {
			return nil, err
		}
		messages = append(messages, batch...)
		jobs, err := c.call(ctx, "islands_step", 256, uint64(c.limits.Fuel))
		if err != nil {
			return nil, err
		}
		if err = c.status(ctx, jobs); err != nil {
			return nil, err
		}
		if jobs == 0 {
			return messages, nil
		}
	}
}
