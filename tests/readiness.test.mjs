import test from "node:test";
import assert from "node:assert/strict";
import {backendReadiness, workerReadiness} from "../extension/shared/constants.js";

const compatible = {status: "ok", service: "panther-intent-capture-backend", app_version: "1.7.0", schema_version: "1.1", bundle_schema_version: "1.2", capabilities: ["review-edit-persistence", "intent-bundle-1.2"]};

test("backend compatibility requires advertised semantics, not version or source alone", () => {
  assert.equal(backendReadiness(compatible).ready, true);
  for (const change of [{app_version: null}, {service: "different-service"}, {status: "starting"}, {schema_version: "1.0"}, {bundle_schema_version: "1.0"}, {capabilities: ["intent-bundle-1.2"]}, {capabilities: "review-edit-persistence intent-bundle-1.2"}]) {
    assert.equal(backendReadiness({...compatible, ...change}).ready, false, JSON.stringify(change));
  }
  assert.deepEqual(backendReadiness(null), {connected: false, ready: false, version: "unknown"});
});

test("worker metadata is its own contract and never accepts a version alone", () => {
  assert.equal(workerReadiness({capture_contract: 2, app_version: "1.7.0"}), true);
  for (const worker of [null, {}, {app_version: "1.7.0"}, {capture_contract: true, app_version: "1.7.0"}, {capture_contract: 2, app_version: "unknown"}]) assert.equal(workerReadiness(worker), false);
});
