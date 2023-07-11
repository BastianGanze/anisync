import fs, { Stats } from "fs";
import { getFTPClient, FTP } from "./ftp";
import Handlebars from "handlebars";
import ErrnoException = NodeJS.ErrnoException;
import { match, P } from "ts-pattern";
import { Communication } from "./communication";
import { FileInfo } from "basic-ftp";
import { ApplicationState } from "./index";
import { Config, SyncMap } from "@shared/types";

let currentWriteStream: fs.WriteStream | null = null;

export type SyncResult =
  | { type: "Success" }
  | { type: "Aborted" }
  | { type: "Error"; error: Error };

export async function syncFiles(
  applicationState: ApplicationState
): Promise<void> {
  if (applicationState.syncInProgress) {
    applicationState.communication.logWarning(
      "Tried to start another sync while sync was still in progress!",
    );
    return;
  }

  updateSyncStatus(applicationState, true);
  const ftpClient = match(
    await getFTPClient(applicationState.config, applicationState.communication),
  )
    .with({ type: "Ok", data: P.select() }, (res) => res)
    .with({ type: "ConnectionError", message: P.select() }, (err) => {
      applicationState.communication.logError(`FTP Connection error: ${err}"`);
      updateSyncStatus(applicationState, false);
      return null;
    })
    .exhaustive();

  if (ftpClient === null) {
    updateSyncStatus(applicationState, false);
    applicationState.communication.logError(`Could not sync.`);
    return;
  }

  applicationState.communication.logInfo(`Attempting to sync.`);
  for (const syncMap of applicationState.config.syncMaps) {
    const syncResult = await sync(
      syncMap,
      ftpClient,
      applicationState.config,
        applicationState.communication,
    );
    const abortSync = match(syncResult)
      .with({ type: "Success" }, () => false)
      .with({ type: "Aborted" }, () => true)
      .with({ type: "Error" }, () => false)
      .exhaustive();
    if (abortSync) {
      break;
    }
  }
  updateSyncStatus(applicationState, false);
  applicationState.communication.logInfo(`Sync done!`);

  ftpClient.close();
}

function updateSyncStatus(
  applicationState: ApplicationState,
  status: boolean,
) {
  applicationState.syncInProgress = status;
  applicationState.communication.dispatch({
    type: "syncStatus",
    isSyncing: status,
  });
}

export function toggleAutoSync(
  applicationState: ApplicationState,
  enabled: boolean,
): void {
  if (applicationState.autoSyncIntervalHandler) {
    clearInterval(applicationState.autoSyncIntervalHandler);
    delete applicationState.autoSyncIntervalHandler;
  }

  if (enabled) {
    const interval = Math.max(
      applicationState.config.autoSyncIntervalInMinutes
        ? applicationState.config.autoSyncIntervalInMinutes
        : 30,
      5,
    );

    applicationState.communication.logInfo(`AutoSync enabled! Interval is ${interval} minutes.`);

    applicationState.autoSyncIntervalHandler = setInterval(
      () => syncFiles(applicationState),
      interval * 60 * 1000,
    );
  } else {
    applicationState.communication.logInfo("AutoSync disabled!");
  }
}

function getFileMatchesMap(
  dir: FileInfo[],
  syncMap: SyncMap,
  config: Config,
  communication: Communication,
): FileMatchesMap {
  const fileMatchesMap: FileMatchesMap = {};

  for (const listingElement of dir) {
    const renameTemplate = syncMap.rename
      ? Handlebars.compile(syncMap.fileRenameTemplate)
      : Handlebars.compile(listingElement.name);
    const match = syncMap.rename
      ? listingElement.name.match(syncMap.fileRegex)
      : "no_rename".match("no_rename");
    if (match === null) {
      if (config.debugFileNames) {
        communication.logDebug(
          `File did not match regex "${listingElement.name}". Not loading.`,
        );
      }
      continue;
    }

    const templateData: { [key: string]: string } = {
      $syncName: syncMap.id,
    };
    for (let i = 0; i < match.length; i++) {
      templateData["$" + i] = match[i];
    }

    const newName = renameTemplate(templateData);
    const remoteFile = `${syncMap.originFolder}/${listingElement.name}`;
    const localFile = Handlebars.compile(
      `${syncMap.destinationFolder}/${newName}`,
    )(templateData);

    if (!fileMatchesMap[localFile]) {
      fileMatchesMap[localFile] = {
        fileStatOnDisk: null,
        remoteFilesMatching: [],
      };
    }

    fileMatchesMap[localFile].remoteFilesMatching.push({
      path: remoteFile,
      listingElement,
    });

    if (fs.existsSync(localFile)) {
      fileMatchesMap[localFile].fileStatOnDisk = fs.statSync(localFile);
    }
  }

  return fileMatchesMap;
}

export function abortSync(): void {
  currentWriteStream.destroy(new Error("Manual abortion."));
}

async function sync(
  syncMap: SyncMap,
  ftpClient: FTP,
  config: Config,
  communication: Communication,
): Promise<SyncResult> {
  const localFolder = Handlebars.compile(syncMap.destinationFolder)({
    $syncName: syncMap.id,
  });
  if (!createLocalFolder(localFolder, communication).exists) {
    return {
      type: "Error",
      error: new Error(`Could not create local folder "${localFolder}"`),
    };
  }

  try {
    await ftpClient.cd(syncMap.originFolder);
    const dir = await ftpClient.listDir(syncMap.originFolder);
    const fileMatchesMap = getFileMatchesMap(
      dir,
      syncMap,
      config,
      communication,
    );

    for (const [localFile, fileMatches] of Object.entries(fileMatchesMap)) {
      const latestRemoteMatch = getLatestMatchingFile(fileMatches);

      if (config.debugFileNames) {
        if (syncMap.rename) {
          communication.logDebug(
            `Renaming ${latestRemoteMatch.path} -> ${localFile}`,
          );
        }
      }

      if (fileMatches.fileStatOnDisk) {
        if (
          fileMatches.fileStatOnDisk.size ==
          latestRemoteMatch.listingElement.size
        ) {
          continue;
        } else {
          communication.logWarning(
            `New version or damaged file detected, reloading ${localFile}`,
          );
        }
      } else {
        communication.logInfo(
          `New episode detected, loading ${localFile} now.`,
        );
      }

      currentWriteStream = fs.createWriteStream(localFile);
      await ftpClient.getFile(
        latestRemoteMatch.path,
        currentWriteStream,
        latestRemoteMatch.listingElement.size,
      );
    }
    return { type: "Success" };
  } catch (e) {
    if (e instanceof Error) {
      if ("code" in e) {
        const error = e as { code: number };
        if (error.code == 550) {
          communication.logError(
            `Directory "${syncMap.originFolder}" does not exist on remote.`,
          );
        }
        return { type: "Error", error: e };
      } else if (e.message === "Manual abortion.") {
        communication.logWarning(
          `Sync was manually stopped. File will be downloaded again.`,
        );
        return { type: "Aborted" };
      } else {
        communication.logError(`Unknown error ${e.message}`);
        return { type: "Error", error: e };
      }
    }

    communication.logError(`Unknown error ${e}`);
    return { type: "Error", error: e };
  }
}

interface RemoteFileMatching {
  path: string;
  listingElement: FileInfo;
}

interface FileMatchesMapEntry {
  fileStatOnDisk: Stats | null;
  remoteFilesMatching: RemoteFileMatching[];
}

interface FileMatchesMap {
  [localFile: string]: FileMatchesMapEntry;
}

function getLatestMatchingFile(
  fileMatches: FileMatchesMapEntry,
): RemoteFileMatching {
  fileMatches.remoteFilesMatching.sort((a, b) =>
    a.listingElement.date > b.listingElement.date ? -1 : 1,
  );

  return fileMatches.remoteFilesMatching[0];
}

function createLocalFolder(
  destinationFolder: string,
  communication: Communication,
): { exists: boolean } {
  try {
    if (!fs.existsSync(destinationFolder)) {
      fs.mkdirSync(destinationFolder, { recursive: true });
    }
    return { exists: true };
  } catch (e) {
    if (e instanceof Error) {
      if ("code" in e) {
        const error = e as ErrnoException;
        communication.logError(
          `Could not create folder on file system, "${destinationFolder}" is faulty: "${error.message}"`,
        );
      }
    }
  }
  return { exists: false };
}