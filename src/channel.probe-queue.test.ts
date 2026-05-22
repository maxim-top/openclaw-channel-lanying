/// <reference types="node" />

import assert from "node:assert/strict";
import test from "node:test";

import { ClawchatSession } from "./channel.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function createProbe(probeId: string) {
  return {
    cfg: {},
    probe: {
      probeId,
      formatVersion: 1,
      checks: {
        health: {},
      },
    },
  };
}

test("probe queue only reports the latest probe within the debounce window", async () => {
  const session = new ClawchatSession() as any;
  const reportedProbeIds: string[] = [];

  session.collectProbeReport = async ({ probe }: { probe: { probeId: string } }) => ({
    probeId: probe.probeId,
    results: {},
  });
  session.sendProbeReportToSelf = async ({ probeId }: { probeId: string }) => {
    reportedProbeIds.push(probeId);
  };

  const first = session.handleProbeRequest(createProbe("probe-old"));
  await sleep(50);
  const second = session.handleProbeRequest(createProbe("probe-new"));
  await Promise.all([first, second]);

  assert.deepEqual(reportedProbeIds, ["probe-new"]);
});

test("probe queue drops a stale in-flight report when a newer probe arrives", async () => {
  const session = new ClawchatSession() as any;
  const reportedProbeIds: string[] = [];

  session.collectProbeReport = async ({ probe }: { probe: { probeId: string } }) => {
    if (probe.probeId === "probe-old") {
      await sleep(120);
    }
    return {
      probeId: probe.probeId,
      results: {},
    };
  };
  session.sendProbeReportToSelf = async ({ probeId }: { probeId: string }) => {
    reportedProbeIds.push(probeId);
  };

  const first = session.handleProbeRequest(createProbe("probe-old"));
  await sleep(320);
  const second = session.handleProbeRequest(createProbe("probe-new"));
  await Promise.all([first, second]);

  assert.deepEqual(reportedProbeIds, ["probe-new"]);
});
