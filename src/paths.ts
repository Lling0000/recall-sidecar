import { homedir } from "node:os";
import { join } from "node:path";
import {
  DATA_DIRECTORY_NAME,
  DATABASE_FILENAME,
  SOCKET_FILENAME,
} from "./constants.js";

export interface RuntimePaths {
  dataDirectory: string;
  database: string;
  socket: string;
  backups: string;
}

export function runtimePaths(home = homedir()): RuntimePaths {
  const dataDirectory = join(
    home,
    "Library",
    "Application Support",
    DATA_DIRECTORY_NAME,
  );
  return {
    dataDirectory,
    database: join(dataDirectory, DATABASE_FILENAME),
    socket: join(dataDirectory, SOCKET_FILENAME),
    backups: join(dataDirectory, "backups"),
  };
}
