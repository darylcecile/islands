/* Islands ABI v1. One copy of this state belongs to each WASM instance. */
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

#include "quickjs.h"
#include "guest.h"

#define EXPORT __attribute__((visibility("default")))
#define LINEAR_LIMIT (128u * 1024u * 1024u)
#define STACK_LIMIT (1024u * 1024u)
#define OUTBOX_LIMIT (1024u * 1024u)
#define ERROR_LIMIT 4096u
#define BOOTSTRAP_FUEL 10000

typedef struct Input {
    struct Input *next;
    uint32_t length;
    char bytes[];
} Input;

typedef struct Rejection {
    struct Rejection *next;
    JSValue promise;
    JSValue reason;
} Rejection;

/* Keep returned blocks aligned for every QuickJS allocation. Charge rounded
 * storage, this header, and WASI libc allocator overhead to the guest heap. */
typedef union Allocation {
    max_align_t alignment;
    size_t charge;
} Allocation;

static struct {
    JSRuntime *runtime;
    JSContext *context;
    JSValue receive;
    Input *inputs;
    Rejection *rejections;
    char *output;
    uint32_t output_length;
    uint32_t output_capacity;
    char error[ERROR_LIMIT];
    uint32_t error_length;
    uint32_t heap_limit;
    int32_t fuel;
    bool exhausted;
    bool interrupted;
    bool poisoned;
} core;

static void set_error(const char *message)
{
    size_t length = strlen(message);
    if (length >= ERROR_LIMIT)
        length = ERROR_LIMIT - 1;
    /* Avoid ending a truncated UTF-8 string inside a code point. */
    if (length < strlen(message)) {
        while (length && ((unsigned char)message[length] & 0xc0) == 0x80)
            length--;
    }
    memcpy(core.error, message, length);
    core.error[length] = '\0';
    core.error_length = (uint32_t)length;
}

static size_t allocation_charge(size_t size)
{
    const size_t overhead = sizeof(Allocation) + 16;
    if (size > LINEAR_LIMIT - overhead - 15)
        return LINEAR_LIMIT;
    return ((size + 15) & ~(size_t)15) + overhead;
}

static bool can_allocate(JSMallocState *state, size_t old, size_t charge)
{
    size_t limit = state->malloc_limit;
    if (limit > core.heap_limit)
        limit = core.heap_limit;
    if (charge > limit || state->malloc_size - old > limit - charge) {
        core.exhausted = true;
        return false;
    }
    return true;
}

static void *guest_malloc(JSMallocState *state, size_t size)
{
    size_t charge = allocation_charge(size);
    if (!can_allocate(state, 0, charge))
        return NULL;
    Allocation *block = malloc(charge - 16);
    if (!block) {
        core.exhausted = true;
        return NULL;
    }
    block->charge = charge;
    state->malloc_size += charge;
    state->malloc_count++;
    return block + 1;
}

static void guest_free(JSMallocState *state, void *pointer)
{
    if (!pointer)
        return;
    Allocation *block = (Allocation *)pointer - 1;
    state->malloc_size -= block->charge;
    state->malloc_count--;
    free(block);
}

static void *guest_realloc(JSMallocState *state, void *pointer, size_t size)
{
    if (!pointer)
        return size ? guest_malloc(state, size) : NULL;
    if (!size) {
        guest_free(state, pointer);
        return NULL;
    }
    Allocation *block = (Allocation *)pointer - 1;
    size_t old = block->charge;
    size_t charge = allocation_charge(size);
    if (!can_allocate(state, old, charge))
        return NULL;
    block = realloc(block, charge - 16);
    if (!block) {
        core.exhausted = true;
        return NULL;
    }
    block->charge = charge;
    state->malloc_size = state->malloc_size - old + charge;
    return block + 1;
}

static size_t guest_usable_size(const void *pointer)
{
    if (!pointer)
        return 0;
    const Allocation *block = (const Allocation *)pointer - 1;
    return block->charge - sizeof(Allocation) - 16;
}

static const JSMallocFunctions allocator = {
    guest_malloc, guest_free, guest_realloc, guest_usable_size
};

static int interrupt(JSRuntime *runtime, void *opaque)
{
    (void)runtime;
    (void)opaque;
    if (core.poisoned || core.exhausted)
        return 1;
    if (--core.fuel <= 0) {
        core.interrupted = true;
        return 1;
    }
    return 0;
}

/* Error reporting must not invoke guest toString methods, proxies or getters. */
static void describe_exception(JSContext *context, JSValueConst exception)
{
    JSValue message = JS_UNDEFINED;
    if (JS_IsString(exception)) {
        message = JS_DupValue(context, exception);
    } else if (JS_IsError(context, exception)) {
        JSAtom atom = JS_NewAtom(context, "message");
        if (atom != JS_ATOM_NULL) {
            JSPropertyDescriptor descriptor;
            if (JS_GetOwnProperty(context, &descriptor, exception, atom) > 0) {
                if (JS_IsString(descriptor.value))
                    message = JS_DupValue(context, descriptor.value);
                JS_FreeValue(context, descriptor.value);
                JS_FreeValue(context, descriptor.getter);
                JS_FreeValue(context, descriptor.setter);
            }
            JS_FreeAtom(context, atom);
        }
    }
    set_error("JavaScript exception (non-string error value)");
    if (JS_IsString(message)) {
        const char *text = JS_ToCString(context, message);
        if (text) {
            set_error(*text ? text : "JavaScript exception");
            JS_FreeCString(context, text);
        }
    }
    JS_FreeValue(context, message);
    if (JS_HasException(context))
        JS_FreeValue(context, JS_GetException(context));
}

static int finish(JSValue result)
{
    if (JS_IsException(result)) {
        JSValue exception = JS_GetException(core.context);
        if (!core.error_length)
            describe_exception(core.context, exception);
        JS_FreeValue(core.context, exception);
        core.poisoned = true;
    } else {
        JS_FreeValue(core.context, result);
    }
    if (core.interrupted)
        set_error("QuickJS fuel exhausted");
    else if (core.exhausted)
        set_error("QuickJS heap limit exceeded or linear memory exhausted");
    core.poisoned |= core.interrupted || core.exhausted;
    return core.poisoned ? -1 : 0;
}

static int begin(int32_t fuel)
{
    if (core.poisoned)
        return -1;
    core.error_length = 0;
    core.error[0] = '\0';
    if (!core.context) {
        set_error("Islands runtime is not initialized");
        return -1;
    }
    if (fuel <= 0) {
        set_error("fuel must be a positive i32");
        return -1;
    }
    core.fuel = fuel;
    JS_UpdateStackTop(core.runtime);
    return 0;
}

static JSValue send_message(JSContext *context, JSValueConst this_value,
                            int argc, JSValueConst *argv)
{
    (void)this_value;
    if (argc != 1 || !JS_IsString(argv[0]))
        return JS_ThrowTypeError(context, "__islands_send expects a JSON string");
    size_t length;
    const char *text = JS_ToCStringLen(context, &length, argv[0]);
    if (!text)
        return JS_EXCEPTION;
    if (length >= OUTBOX_LIMIT || length + 1 > OUTBOX_LIMIT - core.output_length) {
        JS_FreeCString(context, text);
        set_error("Islands outbox limit exceeded (1 MiB)");
        core.poisoned = true;
        JS_ThrowInternalError(context, "Islands outbox limit exceeded");
        JS_SetUncatchableException(context, true);
        return JS_EXCEPTION;
    }
    if (!length || memchr(text, '\n', length) || memchr(text, '\r', length) ||
        memchr(text, '\0', length)) {
        JS_FreeCString(context, text);
        return JS_ThrowTypeError(context, "outbox messages must be single-line JSON");
    }
    uint32_t needed = core.output_length + (uint32_t)length + 1;
    if (needed > core.output_capacity) {
        uint32_t capacity = core.output_capacity ? core.output_capacity : 4096;
        while (capacity < needed)
            capacity *= 2;
        char *output = realloc(core.output, capacity);
        if (!output) {
            JS_FreeCString(context, text);
            core.exhausted = true;
            return JS_ThrowOutOfMemory(context);
        }
        core.output = output;
        core.output_capacity = capacity;
    }
    memcpy(core.output + core.output_length, text, length);
    core.output[needed - 1] = '\n';
    core.output_length = needed;
    JS_FreeCString(context, text);
    return JS_UNDEFINED;
}

static void track_rejection(JSContext *context, JSValueConst promise,
                            JSValueConst reason, JS_BOOL handled, void *opaque)
{
    (void)opaque;
    Rejection **link = &core.rejections;
    while (*link && JS_VALUE_GET_PTR((*link)->promise) != JS_VALUE_GET_PTR(promise))
        link = &(*link)->next;
    if (handled) {
        if (*link) {
            Rejection *item = *link;
            *link = item->next;
            JS_FreeValue(context, item->promise);
            JS_FreeValue(context, item->reason);
            js_free_rt(core.runtime, item);
        }
        return;
    }
    if (*link)
        return;
    Rejection *item = js_malloc_rt(core.runtime, sizeof(*item));
    if (!item)
        return;
    item->promise = JS_DupValue(context, promise);
    item->reason = JS_DupValue(context, reason);
    item->next = NULL;
    *link = item;
}

EXPORT uint32_t islands_abi_version(void) { return 1; }

EXPORT uint32_t islands_alloc(uint32_t length)
{
    if (length > LINEAR_LIMIT - sizeof(Input) - 1) {
        set_error("Input allocation exceeds linear memory limit");
        return 0;
    }
    Input *input = malloc(sizeof(*input) + (size_t)length + 1);
    if (!input) {
        set_error("Input allocation failed");
        return 0;
    }
    input->next = core.inputs;
    input->length = length;
    input->bytes[length] = '\0';
    core.inputs = input;
    return (uint32_t)(uintptr_t)input->bytes;
}

EXPORT void islands_free(uint32_t pointer)
{
    Input **link = &core.inputs;
    while (*link && (uintptr_t)(*link)->bytes != pointer)
        link = &(*link)->next;
    if (*link) {
        Input *input = *link;
        *link = input->next;
        free(input);
    }
}

static const char *input_bytes(uint32_t pointer, uint32_t length)
{
    for (Input *input = core.inputs; input; input = input->next) {
        if ((uintptr_t)input->bytes == pointer && length <= input->length) {
            input->bytes[length] = '\0'; /* QuickJS's parser requires this. */
            return input->bytes;
        }
    }
    set_error("Input must refer to an islands_alloc buffer of sufficient size");
    return NULL;
}

EXPORT void islands_destroy(void)
{
    if (core.runtime) {
        JS_SetHostPromiseRejectionTracker(core.runtime, NULL, NULL);
        while (core.rejections) {
            Rejection *item = core.rejections;
            core.rejections = item->next;
            JS_FreeValueRT(core.runtime, item->promise);
            JS_FreeValueRT(core.runtime, item->reason);
            js_free_rt(core.runtime, item);
        }
        JS_FreeValueRT(core.runtime, core.receive);
        if (core.context)
            JS_FreeContext(core.context);
        JS_FreeRuntime(core.runtime);
    }
    core.runtime = NULL;
    core.context = NULL;
    core.receive = JS_UNDEFINED;
    while (core.inputs)
        islands_free((uint32_t)(uintptr_t)core.inputs->bytes);
    free(core.output);
    core.output = NULL;
    core.output_length = core.output_capacity = 0;
    core.poisoned = core.exhausted = core.interrupted = false;
    /* The fixed error buffer deliberately survives destroy and input free. */
}

EXPORT int32_t islands_init(uint32_t memory_bytes, uint32_t stack_bytes)
{
    if (core.runtime) {
        set_error("Islands runtime is already initialized");
        return -1;
    }
    core.error_length = 0;
    core.error[0] = '\0';
    if (!memory_bytes || memory_bytes > LINEAR_LIMIT ||
        !stack_bytes || stack_bytes > STACK_LIMIT) {
        set_error("heap must be 1..134217728 bytes; stack must be 1..1048576 bytes");
        return -1;
    }
    core.heap_limit = memory_bytes;
    core.receive = JS_UNDEFINED;
    core.runtime = JS_NewRuntime2(&allocator, NULL);
    if (!core.runtime) {
        set_error("Cannot allocate QuickJS runtime within heap limit");
        islands_destroy();
        return -1;
    }
    JS_SetMemoryLimit(core.runtime, memory_bytes);
    JS_SetMaxStackSize(core.runtime, stack_bytes);
    JS_SetCanBlock(core.runtime, false);
    JS_SetInterruptHandler(core.runtime, interrupt, NULL);
    core.fuel = BOOTSTRAP_FUEL;
    core.context = JS_NewContext(core.runtime);
    if (!core.context) {
        set_error("Cannot allocate QuickJS context within heap/stack limits");
        islands_destroy();
        return -1;
    }
    JS_SetHostPromiseRejectionTracker(core.runtime, track_rejection, NULL);
    JSValue global = JS_GetGlobalObject(core.context);
    JSValue send = JS_NewCFunction(core.context, send_message, "__islands_send", 1);
    int status = -1;
    if (!JS_IsException(send)) {
        status = JS_DefinePropertyValueStr(core.context, global, "__islands_send", send, 0);
    }
    if (status < 0) {
        finish(JS_EXCEPTION);
    } else {
        JSValue result = JS_Eval(core.context, (const char *)islands_guest,
                                 sizeof(islands_guest) - 1, "islands:guest", JS_EVAL_TYPE_GLOBAL);
        status = finish(result);
        if (!status) {
            core.receive = JS_GetPropertyStr(core.context, global, "__islands_receive");
            if (JS_IsException(core.receive)) {
                status = finish(JS_EXCEPTION);
                core.receive = JS_UNDEFINED;
            } else if (!JS_IsFunction(core.context, core.receive)) {
                set_error("Built-in guest bridge did not install __islands_receive");
                status = -1;
            }
        }
    }
    JS_FreeValue(core.context, global);
    if (status < 0) {
        islands_destroy();
        return -1;
    }
    return 0;
}

EXPORT int32_t islands_eval(uint32_t pointer, uint32_t length, int32_t fuel)
{
    if (begin(fuel) < 0)
        return -1;
    const char *source = input_bytes(pointer, length);
    if (!source)
        return -1;
    return finish(JS_Eval(core.context, source, length, "islands:extension", JS_EVAL_TYPE_GLOBAL));
}

EXPORT int32_t islands_dispatch(uint32_t pointer, uint32_t length, int32_t fuel)
{
    if (begin(fuel) < 0)
        return -1;
    const char *message = input_bytes(pointer, length);
    if (!message)
        return -1;
    JSValue argument = JS_NewStringLen(core.context, message, length);
    if (JS_IsException(argument))
        return finish(argument);
    JSValue result = JS_Call(core.context, core.receive, JS_UNDEFINED, 1, &argument);
    JS_FreeValue(core.context, argument);
    return finish(result);
}

EXPORT int32_t islands_step(int32_t max_jobs, int32_t fuel)
{
    if (begin(fuel) < 0)
        return -1;
    if (max_jobs < 0) {
        set_error("max_jobs must be a nonnegative i32");
        return -1;
    }
    int32_t count = 0;
    while (count < max_jobs && JS_IsJobPending(core.runtime)) {
        JSContext *context = NULL;
        int status = JS_ExecutePendingJob(core.runtime, &context);
        if (status < 0) {
            /* This core only creates one context; QuickJS returns its owner. */
            return finish(JS_EXCEPTION);
        }
        if (finish(JS_UNDEFINED) < 0)
            return -1;
        if (!status)
            break;
        count++;
    }
    if (!JS_IsJobPending(core.runtime) && core.rejections) {
        describe_exception(core.context, core.rejections->reason);
        core.poisoned = true;
        return -1;
    }
    return count;
}

EXPORT uint32_t islands_output_ptr(void) { return (uint32_t)(uintptr_t)core.output; }
EXPORT uint32_t islands_output_len(void) { return core.output_length; }
EXPORT void islands_output_clear(void) { core.output_length = 0; }
EXPORT uint32_t islands_error_ptr(void) { return (uint32_t)(uintptr_t)core.error; }
EXPORT uint32_t islands_error_len(void) { return core.error_length; }
