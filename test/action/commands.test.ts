/** Input reading and command dispatch, with the flow functions mocked. */

import { describe, expect, it, vi } from "vitest";
import { dispatch, type Flows, outputsFor } from "../../action/src/commands.ts";
import { COMMANDS, type Inputs, readInputs } from "../../action/src/inputs.ts";
import { LaunchsetError } from "../../src/core/errors.ts";
import type { FlowContext, FlowResult } from "../../src/flow/index.ts";

const ok = (overrides: Partial<FlowResult> = {}): FlowResult => ({
  ok: true,
  outputs: {},
  summary: "",
  lines: [],
  data: {},
  ...overrides,
});

function mockFlows() {
  const flows = {
    add: vi.fn(async () => ok()),
    check: vi.fn(async () => ok()),
    finalize: vi.fn(async () => ok()),
    mark: vi.fn(async () => ok()),
    previewComment: vi.fn(async () => ok()),
    previewPlan: vi.fn(async () => ok()),
    release: vi.fn(async () => ok()),
    stamp: vi.fn(async () => ok()),
    verify: vi.fn(async () => ok()),
  };
  return flows as unknown as Flows & typeof flows;
}

const context = { event: undefined } as unknown as FlowContext;

function inputs(overrides: Partial<Inputs> & { command: Inputs["command"] }): Inputs {
  return {
    token: "",
    target: "",
    bump: "",
    message: "",
    version: "",
    plan: "",
    workingDirectory: ".",
    ...overrides,
  };
}

const getter = (values: Record<string, string>) => (name: string) => values[name] ?? "";

describe("readInputs", () => {
  it("reads every input and defaults working-directory to .", () => {
    expect(
      readInputs(
        getter({
          command: " Stamp ",
          token: "t",
          target: "android",
          bump: "patch",
          message: "m",
          version: "1.0.0",
          plan: "{}",
        }),
      ),
    ).toEqual({
      command: "stamp",
      token: "t",
      target: "android",
      bump: "patch",
      message: "m",
      version: "1.0.0",
      plan: "{}",
      workingDirectory: ".",
    });
    expect(readInputs(getter({ command: "check", "working-directory": "apps/x" }))).toMatchObject({
      workingDirectory: "apps/x",
    });
  });

  it("accepts every command of the spec", () => {
    expect(COMMANDS).toEqual([
      "check",
      "release",
      "stamp",
      "verify",
      "mark",
      "finalize",
      "preview-plan",
      "preview-comment",
      "add",
    ]);
    for (const command of COMMANDS) expect(readInputs(getter({ command })).command).toBe(command);
  });

  it("lists the valid commands for an unknown or missing command", () => {
    for (const command of ["deploy", ""]) {
      try {
        readInputs(getter({ command }));
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(LaunchsetError);
        expect((error as LaunchsetError).code).toBe("unknown-command");
        expect((error as LaunchsetError).hint).toContain(COMMANDS.join(", "));
      }
    }
  });
});

describe("dispatch", () => {
  it("check posts the sticky comment", async () => {
    const flows = mockFlows();
    await dispatch("check", inputs({ command: "check" }), context, flows);
    expect(flows.check).toHaveBeenCalledWith(context, { comment: true });
  });

  it("release passes target and version only when set", async () => {
    const flows = mockFlows();
    await dispatch("release", inputs({ command: "release" }), context, flows);
    expect(flows.release).toHaveBeenLastCalledWith(context, {});
    await dispatch(
      "release",
      inputs({ command: "release", target: "ios", version: "1.4.0" }),
      context,
      flows,
    );
    expect(flows.release).toHaveBeenLastCalledWith(context, { target: "ios", version: "1.4.0" });
  });

  it.each(["stamp", "verify"] as const)("%s needs target and plan", async (command) => {
    const flows = mockFlows();
    await dispatch(command, inputs({ command, target: "web", plan: "{p}" }), context, flows);
    expect(flows[command]).toHaveBeenCalledWith(context, { target: "web", plan: "{p}" });
    await expect(
      dispatch(command, inputs({ command, plan: "{p}" }), context, flows),
    ).rejects.toMatchObject({ code: "missing-input", message: expect.stringContaining("target") });
    await expect(
      dispatch(command, inputs({ command, target: "web" }), context, flows),
    ).rejects.toMatchObject({ code: "missing-input", message: expect.stringContaining("plan") });
  });

  it("mark uses the plan, or the version when shipped by hand", async () => {
    const flows = mockFlows();
    await dispatch("mark", inputs({ command: "mark", target: "ios", plan: "{p}" }), context, flows);
    expect(flows.mark).toHaveBeenLastCalledWith(context, { target: "ios", plan: "{p}" });
    await dispatch(
      "mark",
      inputs({ command: "mark", target: "ios", version: "1.4.0" }),
      context,
      flows,
    );
    expect(flows.mark).toHaveBeenLastCalledWith(context, { target: "ios", version: "1.4.0" });
  });

  it("finalize needs the plan", async () => {
    const flows = mockFlows();
    await dispatch("finalize", inputs({ command: "finalize", plan: "{p}" }), context, flows);
    expect(flows.finalize).toHaveBeenCalledWith(context, { plan: "{p}" });
    await expect(
      dispatch("finalize", inputs({ command: "finalize" }), context, flows),
    ).rejects.toMatchObject({ code: "missing-input" });
  });

  it("preview-plan passes a given target through (previewPlan splits it); preview-comment passes the (maybe empty) plan", async () => {
    const flows = mockFlows();
    await dispatch("preview-plan", inputs({ command: "preview-plan" }), context, flows);
    expect(flows.previewPlan).toHaveBeenLastCalledWith(context, {});
    await dispatch(
      "preview-plan",
      inputs({ command: "preview-plan", target: " , " }),
      context,
      flows,
    );
    expect(flows.previewPlan).toHaveBeenLastCalledWith(context, {});
    await dispatch(
      "preview-plan",
      inputs({ command: "preview-plan", target: "web, android ,," }),
      context,
      flows,
    );
    expect(flows.previewPlan).toHaveBeenLastCalledWith(context, { targets: ["web, android ,,"] });
    await dispatch("preview-comment", inputs({ command: "preview-comment" }), context, flows);
    expect(flows.previewComment).toHaveBeenLastCalledWith(context, { plan: "" });
  });

  it("add passes bump and message", async () => {
    const flows = mockFlows();
    await dispatch("add", inputs({ command: "add", bump: "patch", message: "m" }), context, flows);
    expect(flows.add).toHaveBeenCalledWith(context, { bump: "patch", message: "m" });
  });
});

describe("outputsFor", () => {
  it("derives prerelease from the channel", () => {
    const of = (channel: string) =>
      outputsFor("stamp", ok({ outputs: { channel } }), context).prerelease;
    expect(of("prerelease")).toBe("true");
    expect(of("release")).toBe("false");
    expect(of("preview")).toBe("false");
    expect(of("")).toBe("");
    expect(outputsFor("mark", ok({ outputs: { version: "1" } }), context)).not.toHaveProperty(
      "prerelease",
    );
  });

  it("check: pr-number from the pull_request event", () => {
    const withPr = {
      event: { name: "pull_request", payload: { pull_request: { number: 12 } } },
    } as unknown as FlowContext;
    expect(outputsFor("check", ok(), withPr)["pr-number"]).toBe("12");
    expect(outputsFor("check", ok(), context)["pr-number"]).toBe("");
  });

  it("add: the path of the new changeset", () => {
    const result = ok({ data: { path: ".launchset/a-b-c.md" } });
    expect(outputsFor("add", result, context).path).toBe(".launchset/a-b-c.md");
  });
});
