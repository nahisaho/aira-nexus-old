import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type {
  AssistantMessageEvent,
  CopilotClientOptions,
  MessageOptions,
  SessionConfig,
  SessionEvent,
  SessionEventHandler,
  Tool,
  ToolResultObject,
} from "@github/copilot-sdk";
import type {
  CopilotRuntimeClient,
  CopilotRuntimeFactory,
  CopilotRuntimeSession,
} from "../../src/server/copilot";
import type { ChatDeadline } from "../../src/server/chat";

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

export async function bounded<T>(promise: Promise<T>, label: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Controlled fixture deadline: ${label}`)),
          10000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export function sdkEvent<K extends SessionEvent["type"]>(
  type: K,
  data: Extract<SessionEvent, { type: K }>["data"],
): Extract<SessionEvent, { type: K }> {
  return {
    id: randomUUID(),
    parentId: null,
    timestamp: new Date(0).toISOString(),
    type,
    data,
  } as Extract<SessionEvent, { type: K }>;
}

export function assistant(content: string): AssistantMessageEvent {
  return sdkEvent("assistant.message", {
    messageId: randomUUID(),
    content,
  });
}

export function toolResult(value: unknown): ToolResultObject {
  assert.ok(value && typeof value === "object", "explicit SDK tool result");
  assert.ok("resultType" in value && "textResultForLlm" in value);
  assert.equal(typeof value.textResultForLlm, "string");
  return value as ToolResultObject;
}

export async function invoke(
  tools: Tool<unknown>[],
  name: string,
  args: unknown,
  signal?: AbortSignal,
) {
  const tool = tools.find((entry) => entry.name === name);
  assert.ok(tool?.handler, `${name} has a controlled safe handler`);
  return toolResult(
    await tool.handler(args, {
      sessionId: "synthetic-session",
      toolCallId: randomUUID(),
      toolName: name,
      arguments: args,
      signal,
    }),
  );
}

export interface ControlledScript {
  createError?: Error;
  onCreate?: (call: ControlledCall) => Promise<void>;
  run?: (
    call: ControlledCall,
  ) => Promise<AssistantMessageEvent | undefined>;
  onStop?: (call: ControlledCall) => Promise<void>;
  stopErrors?: Error[];
  forceError?: Error;
}

export class ControlledCall {
  config: SessionConfig | undefined;
  input: MessageOptions | undefined;
  timeout: number | undefined;
  readonly sessionId = randomUUID();
  readonly started = deferred();
  readonly aborted = deferred();
  readonly stopping = deferred();
  readonly listeners = new Set<SessionEventHandler>();
  aborts = 0;
  disconnects = 0;
  stops = 0;
  forced = 0;
  deleted: string[] = [];
  disposed = false;
  private readonly cancelled = deferred<never>();

  constructor(
    readonly options: CopilotClientOptions,
    readonly script: ControlledScript,
  ) {
    // A caller can abort before a send; retain the rejection for a later race.
    void this.cancelled.promise.catch(() => {});
  }

  emit(event: SessionEvent) {
    for (const listener of this.listeners) listener(event);
  }

  async invoke(name: string, args: unknown, signal?: AbortSignal) {
    return invoke(this.config?.tools ?? [], name, args, signal);
  }

  readonly session: CopilotRuntimeSession = {
    sessionId: this.sessionId,
    sendAndWait: async (input, timeout) => {
      this.input = input;
      this.timeout = timeout;
      this.started.resolve();
      const work = (async () => {
        if (this.script.run) return this.script.run(this);
        const reply = assistant("synthetic controlled reply");
        this.emit(reply);
        this.emit(sdkEvent("session.idle", {}));
        return reply;
      })();
      return Promise.race([work, this.cancelled.promise]);
    },
    on: (handler) => {
      this.listeners.add(handler);
      return () => this.listeners.delete(handler);
    },
    abort: async () => {
      this.aborts++;
      this.aborted.resolve();
      this.cancelled.reject(new Error("CONTROLLED_SDK_ABORTED"));
    },
    disconnect: async () => {
      this.disconnects++;
      this.listeners.clear();
    },
  };

  readonly client: CopilotRuntimeClient = {
    createSession: async (config) => {
      this.config = config;
      if (config.onEvent) this.listeners.add(config.onEvent);
      if (this.script.onCreate) await this.script.onCreate(this);
      if (this.script.createError) throw this.script.createError;
      return this.session;
    },
    deleteSession: async (id) => {
      this.deleted.push(id);
    },
    stop: async () => {
      this.stops++;
      this.stopping.resolve();
      if (this.script.onStop) await this.script.onStop(this);
      const errors = this.script.stopErrors ?? [];
      if (!errors.length) this.disposed = true;
      return errors;
    },
    forceStop: async () => {
      this.forced++;
      if (this.script.forceError) throw this.script.forceError;
      this.disposed = true;
      this.cancelled.reject(new Error("CONTROLLED_SDK_STOPPED"));
    },
  };
}

export class ControlledCopilot {
  readonly scripts: ControlledScript[] = [];
  readonly calls: ControlledCall[] = [];
  private readonly waiters = new Map<number, ReturnType<typeof deferred<ControlledCall>>>();

  enqueue(...scripts: ControlledScript[]) {
    this.scripts.push(...scripts);
  }

  readonly factory: CopilotRuntimeFactory = (options) => {
    const script = this.scripts.shift();
    assert.ok(script, "unexpected SDK call; live fallback is never permitted");
    const call = new ControlledCall(options, script);
    this.calls.push(call);
    this.waiters.get(this.calls.length - 1)?.resolve(call);
    return call.client;
  };

  async called(index: number) {
    const existing = this.calls[index];
    if (existing) return existing;
    const waiting = this.waiters.get(index) ?? deferred<ControlledCall>();
    this.waiters.set(index, waiting);
    return bounded(waiting.promise, `SDK call ${index}`);
  }
}

export class ManualChatDeadline implements ChatDeadline {
  readonly entries: {
    milliseconds: number;
    fire: () => void;
    cancelled: boolean;
  }[] = [];

  schedule(milliseconds: number, fire: () => void) {
    const entry = { milliseconds, fire, cancelled: false };
    this.entries.push(entry);
    return () => {
      entry.cancelled = true;
    };
  }

  expire() {
    const active = this.entries.filter((entry) => !entry.cancelled);
    assert.equal(active.length, 1, "one active business deadline");
    assert.equal(active[0].milliseconds, 120000);
    active[0].fire();
  }
}
