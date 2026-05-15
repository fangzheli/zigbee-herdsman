/* istanbul ignore file */

import * as fs from "node:fs";

import type * as Models from "../../../models";
import { BackupUtils } from "../../../utils";
import { logger } from "../../../utils/logger";
import { uint32MaskToChannels } from "../../../zspec/utils";
import type { CoordinatorVersion } from "../../tstype";
import { fixedBufferFromBytes } from "../byteUtils";
import type { BLZFrameData } from "../driver/blz";

const NS = "zh:blz:backup";

interface BlzBackupProvider {
  getCoordinatorVersion: () => CoordinatorVersion;
  getGlobalTcLinkKey: () => Promise<BLZFrameData>;
  getCurrentNetworkParameters: () => Promise<BLZFrameData>;
  getNetworkKeyInfo: () => Promise<BLZFrameData>;
  getMacAddress: () => Promise<Buffer>;
}

function extendedPanIdToBackupBuffer(value: bigint): Buffer {
  const result = Buffer.allocUnsafe(8);
  let extPanId = value;

  for (let i = 0; i < result.length; i++) {
    result[i] = Number(extPanId & 0xffn);
    extPanId >>= 8n;
  }

  return result;
}

export class BLZAdapterBackup {
  private provider: BlzBackupProvider;
  private defaultPath: string;

  public constructor(provider: BlzBackupProvider, path: string) {
    this.provider = provider;
    this.defaultPath = path;
  }

  public async createBackup(
    assertActive: () => void = () => {},
  ): Promise<Models.Backup> {
    logger.debug("creating backup", NS);
    assertActive();
    const version = Number(this.provider.getCoordinatorVersion().meta.product);
    const linkResult = await this.provider.getGlobalTcLinkKey();
    assertActive();
    const netParams = await this.provider.getCurrentNetworkParameters();
    assertActive();
    const netResult = await this.provider.getNetworkKeyInfo();
    assertActive();
    const tclKey = fixedBufferFromBytes(
      linkResult.linkKey,
      16,
      "Trust Center link key must be 16 bytes.",
    );
    const netKey = fixedBufferFromBytes(
      netResult.nwkKey,
      16,
      "Network key must be 16 bytes.",
    );
    let netKeySequenceNumber = 0;
    let netKeyFrameCounter = 0;
    netKeySequenceNumber = netResult.nwkKeySeqNum;
    netKeyFrameCounter = netResult.outgoingFrameCounter;

    const ieee = await this.provider.getMacAddress();
    assertActive();
    /* return backup structure */
    /* istanbul ignore next */
    return {
      blz: {
        version: version,
        tclk: tclKey,
        tclkFrameCounter: linkResult.outgoingFrameCounter,
      },
      networkOptions: {
        panId: netParams.panId,
        // in zigpy/open-coordinator-backup, all binary sequences in this format need to be stored MSB-LSB (big endian)
        extendedPanId: extendedPanIdToBackupBuffer(netParams.extPanId),
        channelList: uint32MaskToChannels(netParams.channelMask),
        networkKey: netKey,
        networkKeyDistribute: true,
      },
      logicalChannel: netParams.channel,
      networkKeyInfo: {
        sequenceNumber: netKeySequenceNumber,
        frameCounter: netKeyFrameCounter,
      },
      securityLevel: 5,
      networkUpdateId: netParams.nwkUpdateId,
      coordinatorIeeeAddress: fixedBufferFromBytes(
        ieee,
        8,
        "Coordinator IEEE address must be 8 bytes.",
      ),
      devices: [],
    };
  }

  /**
   * Loads currently stored backup and returns it in internal backup model.
   */
  public async getStoredBackup(): Promise<Models.Backup | undefined> {
    try {
      await fs.promises.access(this.defaultPath);
    } catch {
      return undefined;
    }
    interface BackupData extends Models.UnifiedBackupStorage {
      metadata: {
        format: "zigpy/open-coordinator-backup";
        version: 1;
        source: string;
        internal: {
          [key: string]: unknown;
          date: string;
          blzVersion?: number;
        };
      };
    }

    let data: unknown;
    try {
      const fileContent = await fs.promises.readFile(this.defaultPath);
      data = JSON.parse(fileContent.toString());
    } catch (error) {
      throw new Error(
        `Coordinator backup is corrupted (${(error as Error).stack})`,
      );
    }

    if (typeof data !== "object" || data === null) {
      throw new Error("Invalid backup data format");
    }

    const backupData = data as BackupData;
    if (
      backupData.metadata?.format === "zigpy/open-coordinator-backup" &&
      backupData.metadata?.version
    ) {
      if (backupData.metadata?.version !== 1) {
        throw new Error(
          `Unsupported open coordinator backup version (version=${backupData.metadata?.version})`,
        );
      }
      // no blz data needed for now
      // if (!data.metadata.internal?.blzVersion) {
      //     throw new Error(`This open coordinator backup format not for BLZ adapter`);
      // }
      return BackupUtils.fromUnifiedBackup(backupData);
    }
    throw new Error("Unknown backup format");
  }
}
