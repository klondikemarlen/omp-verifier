import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { isAbsolute } from "node:path";
import { promisify } from "node:util";

const executeFile = promisify(execFile);
const DOCKER_KINDS = new Set(["docker-container", "docker-volume", "docker-network", "docker-image"]);
const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_MOUNTS = 256;

export function validateDockerResource(resource) {
  validateIdentity(resource);
  if (typeof resource.wrapper !== "string" || resource.wrapper.length > 4096 || !isAbsolute(resource.wrapper) || resource.wrapper.includes("\0")) {
    throw new Error("Docker wrapper must be an absolute file path");
  }
}

export async function observeDockerResources({ repositoryRoot, resources }) {
  let provenance;
  try {
    provenance = await observeProvenance(repositoryRoot);
  } catch {
    return resources.map(resource => ({
      id: resource.id,
      error: "Docker daemon/context identity is unavailable",
    }));
  }

  const observations = [];
  for (const resource of resources) {
    try {
      validateIdentity(resource);
      const observation = await observeResource(repositoryRoot, resource, provenance);
      observations.push(observation);
    } catch {
      observations.push({
        id: resource.id,
        provenance,
        error: "Docker resource identity, project ownership, or bounded inspection is unavailable",
      });
    }
  }

  try {
    const finalProvenance = await observeProvenance(repositoryRoot);
    if (JSON.stringify(provenance) !== JSON.stringify(finalProvenance)) throw new Error("changed daemon");
  } catch {
    return resources.map(resource => ({
      id: resource.id,
      provenance,
      error: "Docker daemon/context changed or became unavailable during observation",
    }));
  }
  return observations;
}

function validateIdentity(resource) {
  if (!resource || !DOCKER_KINDS.has(resource.kind)) throw new Error("Unsupported Docker resource kind");
  if (typeof resource.project !== "string" || resource.project.length > 256 || !/^[a-z0-9][a-z0-9_-]*$/.test(resource.project)) {
    throw new Error("Docker project must be an exact Compose project name");
  }
  if (typeof resource.name !== "string" || resource.name.length > 512) throw new Error("Docker resource must have an exact name or image tag");
  if (resource.kind === "docker-image") {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*:[a-zA-Z0-9_][a-zA-Z0-9_.-]*$/.test(resource.name) || resource.name.includes("//")) {
      throw new Error("Docker image must have an exact explicit tag");
    }
  } else if (!/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(resource.name)) {
    throw new Error("Docker resource must have an exact name or image tag");
  }
}

async function docker(repositoryRoot, args) {
  const result = await executeFile("docker", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    timeout: 10_000,
    maxBuffer: MAX_OUTPUT_BYTES,
    windowsHide: true,
  });
  return result.stdout.trim();
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function boundedString(value) {
  if (typeof value !== "string" || !value || value.length > 4096) throw new Error("invalid evidence string");
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 32 || code === 127) throw new Error("invalid evidence string");
  }
  return value;
}

async function observeProvenance(repositoryRoot) {
  const context = boundedString(await docker(repositoryRoot, ["context", "show"]));
  const endpointOutput = await docker(repositoryRoot, ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}", context]);
  const contextEndpoint = boundedString(JSON.parse(endpointOutput));
  let endpoint = contextEndpoint;
  if (!process.env.DOCKER_CONTEXT && process.env.DOCKER_HOST) endpoint = process.env.DOCKER_HOST;
  const endpointSha256 = fingerprint(endpoint);
  const daemonOutput = await docker(repositoryRoot, ["info", "--format", "{{json .ID}}"]);
  const daemonId = boundedString(JSON.parse(daemonOutput));
  return {
    daemonId,
    context,
    endpointSha256,
  };
}

async function observeResource(repositoryRoot, resource, provenance) {
  const type = resource.kind.slice("docker-".length);
  const args = [type, "ls"];
  if (type === "container") args.push("--all", "--no-trunc");
  if (type === "image") {
    args.push("--filter", `reference=${resource.name}`, "--format", "[{{json .Repository}},{{json .Tag}}]");
  } else {
    args.push("--filter", `name=${resource.name}`, "--format", "{{json .Name}}");
    if (type === "container") args[args.length - 1] = "{{json .Names}}";
  }
  const listing = await docker(repositoryRoot, args);
  const rows = listing ? listing.split("\n").map(line => JSON.parse(line)) : [];
  for (const row of rows) {
    if (type === "image") {
      if (!Array.isArray(row) || row.length !== 2) throw new Error("invalid image discovery");
      boundedString(row[0]);
      boundedString(row[1]);
    } else {
      boundedString(row);
    }
  }
  const isPresent = rows.some(row => {
    if (type === "image") return Array.isArray(row) && `${row[0]}:${row[1]}` === resource.name;
    return row === resource.name;
  });
  if (!isPresent) {
    return {
      id: resource.id,
      present: false,
      provenance,
      identity: {
        provenance,
      },
      details: {},
    };
  }

  // Inspect output is bounded and stays private: only explicit projections and
  // configuration hashes cross the adapter boundary, never environment bodies.
  const output = await docker(repositoryRoot, [type, "inspect", resource.name]);
  const inspected = JSON.parse(output);
  if (!Array.isArray(inspected) || inspected.length !== 1) throw new Error("ambiguous inspection");
  const record = inspected[0];
  if (type === "image") return observeImage(resource, record, provenance);
  const inspectedName = type === "container" ? record.Name?.replace(/^\//, "") : record.Name;
  if (inspectedName !== resource.name) throw new Error("name mismatch");
  const labels = type === "container" ? record.Config?.Labels : record.Labels;
  if (labels?.["com.docker.compose.project"] !== resource.project) throw new Error("project mismatch");

  let stableId = resource.name;
  let configuration;
  let details;
  if (type === "container") {
    stableId = boundedString(record.Id);
    const mounts = observeMounts(record.Mounts);
    const networks = Object.entries(record.NetworkSettings?.Networks ?? {}).map(([name, network]) => ({
      name,
      id: network.NetworkID,
    })).sort((left, right) => left.name.localeCompare(right.name));
    configuration = {
      image: record.Image,
      config: record.Config,
      hostConfig: record.HostConfig,
      mounts,
      networks,
    };
    details = {
      mounts,
    };
  } else if (type === "volume") {
    // Docker volumes have no immutable object ID; creation identity is needed
    // to detect a same-name recreation, unlike volatile container start times.
    const driver = boundedString(record.Driver);
    configuration = {
      createdAt: record.CreatedAt,
      driver,
      options: record.Options,
      labels: record.Labels,
      scope: record.Scope,
      mountpoint: record.Mountpoint,
    };
    boundedString(record.CreatedAt);
    details = {
      driver,
    };
  } else {
    stableId = boundedString(record.Id);
    const driver = boundedString(record.Driver);
    configuration = {
      driver,
      scope: record.Scope,
      internal: record.Internal,
      attachable: record.Attachable,
      ingress: record.Ingress,
      enableIPv6: record.EnableIPv6,
      ipam: record.IPAM,
      options: record.Options,
      labels: record.Labels,
      configFrom: record.ConfigFrom,
      configOnly: record.ConfigOnly,
    };
    details = {
      driver,
    };
  }
  const configurationSha256 = fingerprint(configuration);
  return {
    id: resource.id,
    present: true,
    provenance,
    identity: {
      provenance,
      name: resource.name,
      project: resource.project,
      stableId,
      configurationSha256,
    },
    details,
  };
}

function observeMounts(mounts) {
  if (!Array.isArray(mounts) || mounts.length > MAX_MOUNTS) throw new Error("mount evidence unavailable");
  return mounts.map(mount => {
    const type = boundedString(mount.Type);
    const destination = boundedString(mount.Destination);
    const source = mount.Source ?? null;
    const name = mount.Name ?? null;
    if (source !== null) boundedString(source);
    if (name !== null) boundedString(name);
    const readWrite = mount.RW === true;
    return {
      type,
      source,
      name,
      destination,
      readWrite,
    };
  }).sort((left, right) => left.destination.localeCompare(right.destination));
}

function observeImage(resource, record, provenance) {
  if (!Array.isArray(record.RepoTags) || !record.RepoTags.includes(resource.name)) throw new Error("image tag mismatch");
  const stableId = boundedString(record.Id);
  return {
    id: resource.id,
    present: true,
    provenance,
    identity: {
      provenance,
      name: resource.name,
      project: resource.project,
      stableId,
    },
    details: {},
  };
}
