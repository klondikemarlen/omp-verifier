import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { link, lstat, open, unlink } from "node:fs/promises";

// flock inherits the same open file description as the coordinator. The kernel
// releases its lock when the owner exits, including an uncatchable SIGKILL.
export async function acquireFileLease(handle, waitMs = 0) {
  const lock = spawn("flock", ["--exclusive", "--wait", String(waitMs / 1000), "3"], {
    stdio: ["ignore", "ignore", "ignore", handle.fd],
  });
  const status = await new Promise((accept, reject) => {
    lock.once("error", reject);
    lock.once("exit", accept);
  });
  if (status === 1) {
    return false;
  }

  if (status !== 0) {
    throw new Error("Could not acquire the verifier file lease; check the installed flock command");
  }

  return true;
}

// Older coordinators use an exclusive-create marker at path. Claim that same
// name without stealing a legacy lock. Only our own inode can be reclaimed.
export async function claimOperationLock(path, waitMs, busyMessage) {
  const stablePath = `${path}.lease`;
  const handle = await open(stablePath, constants.O_CREAT | constants.O_RDWR | constants.O_NOFOLLOW, 0o600);
  try {
    if (!await acquireFileLease(handle, waitMs)) {
      throw new Error(busyMessage);
    }

    try {
      await link(stablePath, path);
    } catch (error) {
      if (error.code !== "EEXIST") {
        throw error;
      }

      const marker = await lstat(path, {
        bigint: true,
      });
      const held = await handle.stat({
        bigint: true,
      });
      if (marker.dev !== held.dev || marker.ino !== held.ino) {
        throw new Error(busyMessage, {
          cause: error,
        });
      }
    }
    return async () => {
      try {
        await unlink(path);
      } finally {
        await handle.close();
      }
    };
  } catch (error) {
    await handle.close();
    throw error;
  }
}
