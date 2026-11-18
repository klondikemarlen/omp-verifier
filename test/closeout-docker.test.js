import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { validateDockerResource } from "#root/omp-plugin/closeout-docker.js";

const executeFile = promisify(execFile);
const adapterUrl = import.meta.resolve("#root/omp-plugin/closeout-docker.js");

async function dockerFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "verifier-closeout-docker-"));
  t.after(() => rm(root, {
    recursive: true,
    force: true,
  }));
  const executable = join(root, "docker");
  const statePath = join(root, "state.json");
  const logPath = join(root, "calls.jsonl");
  const wrapper = join(root, "dev");
  await writeFile(wrapper, "#!/bin/sh\nexit 91\n");
  await writeFile(executable, `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
const state = JSON.parse(fs.readFileSync(process.env.DOCKER_FIXTURE_STATE, "utf8"));
fs.appendFileSync(process.env.DOCKER_FIXTURE_LOG, JSON.stringify(args) + "\\n");
if ((state.denied && args[0] === "info") || (state.listDenied && args[1] === "ls")) {
  process.stderr.write("permission denied SECRET_TRANSPORT_CREDENTIAL");
  process.exit(1);
}
if (args[0] === "context" && args[1] === "show") {
  console.log(state.context || "default");
} else if (args[0] === "context" && args[1] === "inspect") {
  console.log(JSON.stringify("unix:///fixture/docker.sock"));
} else if (args[0] === "info") {
  let id = state.daemon || "daemon-one";
  if (state.switchDaemon) {
    const calls = fs.readFileSync(process.env.DOCKER_FIXTURE_LOG, "utf8").trim().split("\\n").map(JSON.parse);
    if (calls.filter(call => call[0] === "info").length > 1) id = "daemon-two";
  }
  console.log(JSON.stringify(id));
} else if (args[1] === "ls") {
  const rows = state.listings?.[args[0]] || [];
  console.log(rows.map(row => JSON.stringify(row)).join("\\n"));
} else if (args[1] === "inspect") {
  const record = state.records?.[args[2]];
  if (!record) {
    process.stderr.write("No such object SECRET_INSPECT_CREDENTIAL");
    process.exit(1);
  }
  console.log(JSON.stringify([record]));
} else {
  process.stderr.write("Unexpected or mutating Docker command");
  process.exit(93);
}
`);
  await chmod(executable, 0o755);

  function resource(kind = "docker-container", name = "task-service") {
    return {
      id: name,
      kind,
      name,
      project: "task",
      wrapper,
    };
  }

  async function observe(resources, state = {}) {
    await writeFile(statePath, JSON.stringify(state));
    await writeFile(logPath, "");
    const script = `import { observeDockerResources } from ${JSON.stringify(adapterUrl)};
const resources = JSON.parse(process.argv[1]);
const repositoryRoot = process.cwd();
const observations = await observeDockerResources({
  repositoryRoot,
  resources,
});
console.log(JSON.stringify(observations));`;
    const serializedResources = JSON.stringify(resources);
    const result = await executeFile(process.execPath, ["--input-type=module", "-e", script, serializedResources], {
      cwd: root,
      env: {
        ...process.env,
        PATH: root,
        DOCKER_HOST: "",
        DOCKER_CONTEXT: "",
        DOCKER_FIXTURE_STATE: statePath,
        DOCKER_FIXTURE_LOG: logPath,
      },
      timeout: 20_000,
    });
    return JSON.parse(result.stdout);
  }

  async function calls() {
    const log = await readFile(logPath, "utf8");
    return log.trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  }

  return {
    root,
    wrapper,
    resource,
    observe,
    calls,
  };
}

function containerRecord() {
  return {
    Id: "container-one",
    Name: "/task-service",
    Image: "sha256:image-one",
    Config: {
      Env: ["PASSWORD=SECRET_ENVIRONMENT"],
      Labels: {
        "com.docker.compose.project": "task",
        "private-label": "SECRET_LABEL",
      },
    },
    HostConfig: {
      Binds: ["task-data:/data:rw"],
    },
    Mounts: [{
      Type: "volume",
      Source: "/var/lib/docker/volumes/task-data/_data",
      Name: "task-data",
      Destination: "/data",
      RW: true,
    }],
    NetworkSettings: {
      Networks: {
        "task-default": {
          NetworkID: "network-one",
          IPAddress: "172.20.0.2",
        },
      },
    },
    State: {
      Pid: 100,
      StartedAt: "2026-11-18T00:00:00Z",
    },
  };
}

test("when Docker input is malformed, validation rejects patterns and missing wrapper evidence", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const resource = fixture.resource();
  const missingWrapperPath = join(fixture.root, "missing");
  const resourceWithoutWrapper = {
    ...resource,
  };
  delete resourceWithoutWrapper.wrapper;

  // Act / Assert
  assert.doesNotThrow(() => validateDockerResource(resource));
  assert.throws(() => validateDockerResource({
    ...resource,
    name: "task-*",
  }), /exact name/);
  assert.throws(() => validateDockerResource({
    ...resource,
    project: "task;exit",
  }), /exact Compose project/);
  assert.throws(() => validateDockerResource({
    ...resource,
    wrapper: "relative-wrapper",
  }), /absolute file path/);
  assert.throws(() => validateDockerResource(resourceWithoutWrapper), /absolute file path/);
  assert.doesNotThrow(() => validateDockerResource({
    ...resource,
    wrapper: missingWrapperPath,
  }));
  assert.throws(() => validateDockerResource({
    ...resource,
    kind: "docker-image",
    name: "alpine",
  }), /explicit tag/);
});

test("when a scoped listing has only partial name matches, absence retains fresh daemon provenance", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const resource = fixture.resource();
  await rm(fixture.wrapper);

  // Act
  const [observation] = await fixture.observe([resource], {
    listings: {
      container: ["other-task-service", "task-service-copy"],
    },
  });
  const calls = await fixture.calls();

  // Assert
  assert.equal(observation.present, false);
  assert.equal(observation.identity.provenance.daemonId, "daemon-one");
  assert.equal(observation.identity.provenance.context, "default");
  assert.match(observation.identity.provenance.endpointSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(observation.provenance, observation.identity.provenance);
  assert.equal(calls.some(call => call[1] === "inspect" && call[0] === "container"), false);
  assert.equal(calls.filter(call => call[0] === "info").length, 2);
});

test("when daemon access is denied, the result is unavailable rather than absent and never leaks stderr", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const resource = fixture.resource();

  // Act
  const [observation] = await fixture.observe([resource], {
    denied: true,
  });

  // Assert
  assert.match(observation.error, /unavailable/);
  assert.equal(observation.present, undefined);
  assert.equal(JSON.stringify(observation).includes("SECRET"), false);
});

test("when a container is retained, stable configuration and bounded mounts exclude secrets and runtime churn", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const resource = fixture.resource();
  const record = containerRecord();
  const state = {
    listings: {
      container: ["task-service"],
    },
    records: {
      "task-service": record,
    },
  };

  // Act
  const [before] = await fixture.observe([resource], state);
  record.State.Pid = 999;
  record.State.StartedAt = "2026-11-19T00:00:00Z";
  record.NetworkSettings.Networks["task-default"].IPAddress = "172.20.0.3";
  const [after] = await fixture.observe([resource], state);
  record.Config.Env = ["PASSWORD=CHANGED_SECRET"];
  const [changed] = await fixture.observe([resource], state);
  const calls = await fixture.calls();

  // Assert
  assert.equal(before.present, true);
  assert.equal(before.identity.stableId, "container-one");
  assert.deepEqual(before.identity, after.identity);
  assert.notEqual(changed.identity.configurationSha256, before.identity.configurationSha256);
  assert.deepEqual(before.details.mounts, [{
    type: "volume",
    source: "/var/lib/docker/volumes/task-data/_data",
    name: "task-data",
    destination: "/data",
    readWrite: true,
  }]);
  assert.equal(JSON.stringify(before).includes("SECRET"), false);
  assert.equal(JSON.stringify(before).includes("Env"), false);
  assert.equal(calls.every(call => ["context", "info"].includes(call[0]) || ["ls", "inspect"].includes(call[1])), true);
});

test("when project or exact inspected identity disagrees, other resource observations survive", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const container = fixture.resource();
  const volume = fixture.resource("docker-volume", "task-data");
  const record = containerRecord();
  record.Config.Labels["com.docker.compose.project"] = "foreign";

  // Act
  const observations = await fixture.observe([container, volume], {
    listings: {
      container: ["task-service"],
      volume: [],
    },
    records: {
      "task-service": record,
    },
  });
  record.Config.Labels["com.docker.compose.project"] = "task";
  record.Name = "/task-service-copy";
  const [mismatched] = await fixture.observe([container], {
    listings: {
      container: ["task-service"],
    },
    records: {
      "task-service": record,
    },
  });

  // Assert
  assert.match(observations[0].error, /project ownership/);
  assert.equal(observations[0].present, undefined);
  assert.equal(observations[1].present, false);
  assert.match(mismatched.error, /identity/);
});

test("when volume and network identities are inspected, configuration changes remain observable without private options", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const volume = fixture.resource("docker-volume", "task-data");
  const network = fixture.resource("docker-network", "task-default");
  const labels = {
    "com.docker.compose.project": "task",
  };
  const state = {
    listings: {
      volume: ["task-data-copy", "task-data"],
      network: ["task-default"],
    },
    records: {
      "task-data": {
        Name: "task-data",
        CreatedAt: "2026-11-18T00:00:00Z",
        Driver: "local",
        Labels: labels,
        Options: {
          password: "SECRET_VOLUME_OPTION",
        },
      },
      "task-default": {
        Name: "task-default",
        Id: "network-one",
        Driver: "bridge",
        Labels: labels,
        Containers: {},
        Options: {
          private: "SECRET_NETWORK_OPTION",
        },
      },
    },
  };

  // Act
  const before = await fixture.observe([volume, network], state);
  state.records["task-data"].CreatedAt = "2026-11-19T00:00:00Z";
  state.records["task-default"].Containers = {
    transient: {
      Name: "unrelated-service",
    },
  };
  const after = await fixture.observe([volume, network], state);

  // Assert
  assert.equal(before[0].present, true);
  assert.equal(before[1].identity.stableId, "network-one");
  assert.notEqual(before[0].identity.configurationSha256, after[0].identity.configurationSha256);
  assert.deepEqual(before[1].identity, after[1].identity);
  assert.equal(JSON.stringify(before).includes("SECRET"), false);
  assert.equal(JSON.stringify(after).includes("unrelated-service"), false);
});

test("when an exact image tag is present, its immutable image ID is recorded without demanding Compose labels", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const resource = fixture.resource("docker-image", "alpine:3.20");
  const state = {
    listings: {
      image: [["alpine", "3.20"], ["alpine", "3.20-copy"]],
    },
    records: {
      "alpine:3.20": {
        Id: "sha256:image-one",
        RepoTags: ["alpine:3.20"],
        Config: {
          Env: ["SECRET_IMAGE_ENV"],
        },
      },
    },
  };

  // Act
  const [present] = await fixture.observe([resource], state);
  state.listings.image = [["alpine", "3.20-copy"]];
  const [absent] = await fixture.observe([resource], state);

  // Assert
  assert.equal(present.present, true);
  assert.equal(present.identity.stableId, "sha256:image-one");
  assert.equal(absent.present, false);
  assert.equal(JSON.stringify(present).includes("SECRET"), false);
});

test("when the daemon changes during a probe, apparent absence is unavailable", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const resource = fixture.resource();

  // Act
  const [observation] = await fixture.observe([resource], {
    switchDaemon: true,
  });

  // Assert
  assert.match(observation.error, /changed or became unavailable/);
  assert.equal(observation.present, undefined);
});

test("when exact discovery succeeds but inspect disappears or mount evidence exceeds bounds, neither result certifies absence", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const resource = fixture.resource();
  const record = containerRecord();
  record.Mounts = Array.from({
    length: 257,
  }, () => record.Mounts[0]);

  // Act
  const [missingInspect] = await fixture.observe([resource], {
    listings: {
      container: ["task-service"],
    },
  });
  const [tooManyMounts] = await fixture.observe([resource], {
    listings: {
      container: ["task-service"],
    },
    records: {
      "task-service": record,
    },
  });

  // Assert
  assert.match(missingInspect.error, /unavailable/);
  assert.equal(missingInspect.present, undefined);
  assert.equal(JSON.stringify(missingInspect).includes("SECRET"), false);
  assert.match(tooManyMounts.error, /bounded inspection/);
});

test("when scoped discovery is denied after daemon identification, no resource is reported absent", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const resource = fixture.resource();

  // Act
  const [observation] = await fixture.observe([resource], {
    listDenied: true,
  });

  // Assert
  assert.match(observation.error, /unavailable/);
  assert.equal(observation.present, undefined);
  assert.equal(observation.provenance.daemonId, "daemon-one");
  assert.equal(JSON.stringify(observation).includes("SECRET"), false);
});

test("when volume or network project labels are foreign, neither exact name authorizes ownership", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const volume = fixture.resource("docker-volume", "task-data");
  const network = fixture.resource("docker-network", "task-default");
  const labels = {
    "com.docker.compose.project": "foreign",
  };

  // Act
  const observations = await fixture.observe([volume, network], {
    listings: {
      volume: ["task-data"],
      network: ["task-default"],
    },
    records: {
      "task-data": {
        Name: "task-data",
        CreatedAt: "2026-11-18T00:00:00Z",
        Driver: "local",
        Labels: labels,
      },
      "task-default": {
        Name: "task-default",
        Id: "network-one",
        Driver: "bridge",
        Labels: labels,
      },
    },
  });

  // Assert
  assert.equal(observations.length, 2);
  for (const observation of observations) {
    assert.match(observation.error, /project ownership/);
    assert.equal(observation.present, undefined);
  }
});

test("when image inspection resolves a different tag, discovery does not establish exact identity", async t => {
  // Arrange
  const fixture = await dockerFixture(t);
  const resource = fixture.resource("docker-image", "alpine:3.20");

  // Act
  const [observation] = await fixture.observe([resource], {
    listings: {
      image: [["alpine", "3.20"]],
    },
    records: {
      "alpine:3.20": {
        Id: "sha256:other-image",
        RepoTags: ["alpine:other"],
      },
    },
  });

  // Assert
  assert.match(observation.error, /identity/);
  assert.equal(observation.present, undefined);
});
