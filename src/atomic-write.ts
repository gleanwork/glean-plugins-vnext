import fs from "node:fs";
import path from "node:path";

/**
 * Write a file so no reader can observe a partial one.
 *
 * `fs.writeFileSync` truncates and then writes, so a process killed mid-write leaves a
 * truncated file behind. Every store here parses JSON and treats a parse failure as "no
 * data", so a torn write does not surface as an error — it silently discards whatever was
 * stored. For the policy cache that is the one outcome we have gone out of our way to
 * prevent: nothing is allowed to clear it, precisely because a cached policy may carry a
 * deactivation or a version block, and a crash mid-write would clear it anyway.
 *
 * Writing to a sibling temp file and renaming makes the swap atomic — a reader sees either
 * the old contents or the new ones, never a mixture. The temp file must live in the same
 * directory, since rename is only atomic within a filesystem, and it carries the pid
 * because each host session runs its own plugin process and they share these files.
 *
 * This is NOT mutual exclusion. Two processes doing read-modify-write can still lose one
 * update, last writer winning; they simply cannot corrupt the file. A lost update
 * self-heals on the next negotiation, whereas a corrupt file discards every entry for
 * every URL until something rewrites it.
 *
 * On failure the temp file is removed and the error rethrown, leaving whatever was
 * already on disk intact. Windows can fail the rename with EPERM/EBUSY when another
 * process holds the target open; callers already tolerate a failed write, so that
 * degrades to "this write was skipped" rather than to corruption.
 */
export function writeFileAtomicSync(
  filePath: string,
  data: string,
  mode: number,
): void {
  const tmpPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.tmp`,
  );
  try {
    fs.writeFileSync(tmpPath, data, { encoding: "utf-8", mode });
    // writeFileSync only applies `mode` when it creates the file, so a leftover temp
    // from a previous crash could otherwise keep looser permissions.
    fs.chmodSync(tmpPath, mode);
    fs.renameSync(tmpPath, filePath);
  } catch (err) {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Nothing further to do; the target is untouched either way.
    }
    throw err;
  }
}
