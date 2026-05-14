import {vi, describe, it, expect, beforeEach} from 'vitest';
import * as fs from 'fs';
import {BLZAdapterBackup} from '../../../../src/adapter/blz/adapter/backup';
import {Driver} from '../../../../src/adapter/blz/driver/driver';
import * as BackupUtils from '../../../../src/utils/backup';

vi.mock('fs', async (importOriginal) => ({
    ...(await importOriginal<typeof import('fs')>()),
    promises: {
        access: vi.fn(),
        readFile: vi.fn(),
    },
}));
vi.mock('../../../../src/adapter/blz/driver/driver');
vi.mock('../../../../src/utils/backup');

describe('BLZ Adapter Backup', () => {
    let backup: BLZAdapterBackup;
    let driverMock: {
        blz: {
            version: {product: number};
            execCommand: ReturnType<typeof vi.fn>;
        };
        getBlz: ReturnType<typeof vi.fn>;
        getCoordinatorVersion: ReturnType<typeof vi.fn>;
        getGlobalTcLinkKey: ReturnType<typeof vi.fn>;
        getNetworkKeyInfo: ReturnType<typeof vi.fn>;
        getCurrentNetworkParameters: ReturnType<typeof vi.fn>;
        getMacAddress: ReturnType<typeof vi.fn>;
    };

    const backupPath = '/path/to/backup.json';

    beforeEach(() => {
        vi.clearAllMocks();
        driverMock = {
            blz: {
                version: {product: 1},
                execCommand: vi.fn(),
            },
            getBlz: vi.fn(),
            getCoordinatorVersion: vi.fn(),
            getGlobalTcLinkKey: vi.fn(),
            getNetworkKeyInfo: vi.fn(),
            getCurrentNetworkParameters: vi.fn(),
            getMacAddress: vi.fn(),
        };
        driverMock.getBlz.mockReturnValue(driverMock.blz);
        driverMock.getCoordinatorVersion.mockReturnValue({
            type: 'BLZ v1',
            meta: driverMock.blz.version,
        });

        vi.mocked(Driver).mockImplementation(() => driverMock as any);
        backup = new BLZAdapterBackup(driverMock as any, backupPath);
    });

    describe('Creating backup', () => {
        it('should create backup successfully', async () => {
            // Mock network parameters response
            driverMock.blz.execCommand.mockRejectedValue(
                new Error('backup should use driver command wrappers'),
            );
            driverMock.getBlz.mockImplementation(() => {
                throw new Error('transport leaked');
            });
            driverMock.getCurrentNetworkParameters.mockResolvedValue({
                panId: 0x1234,
                extPanId: BigInt('0x0102030405060708'),
                channel: 11,
                channelMask: 0x800, // Channel 11
                nwkUpdateId: 0,
            });
            driverMock.getMacAddress.mockResolvedValue(
                Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
            );

            // Mock key responses
            driverMock.getGlobalTcLinkKey.mockResolvedValue({
                linkKey: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
                outgoingFrameCounter: 1234,
            });

            driverMock.getNetworkKeyInfo.mockResolvedValue({
                nwkKey: Buffer.from([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]),
                nwkKeySeqNum: 5,
                outgoingFrameCounter: 5678,
            });

            const result = await backup.createBackup();

            // The extendedPanId is built with push() extracting LSB first
            // So for 0x0102030405060708, the result is [8, 7, 6, 5, 4, 3, 2, 1]
            expect(result).toEqual({
                blz: {
                    version: 1,
                    tclk: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
                    tclkFrameCounter: 1234,
                },
                networkOptions: {
                    panId: 0x1234,
                    extendedPanId: Buffer.from([8, 7, 6, 5, 4, 3, 2, 1]),
                    channelList: [11],
                    networkKey: Buffer.from([16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1]),
                    networkKeyDistribute: true,
                },
                logicalChannel: 11,
                networkKeyInfo: {
                    sequenceNumber: 5,
                    frameCounter: 5678,
                },
                securityLevel: 5,
                networkUpdateId: 0,
                coordinatorIeeeAddress: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
                devices: [],
            });
            expect(driverMock.blz.execCommand).not.toHaveBeenCalled();
        });

        it('should serialize the extended PAN ID without an intermediate byte array', async () => {
            driverMock.getCurrentNetworkParameters.mockResolvedValue({
                panId: 0x1234,
                extPanId: BigInt('0x0102030405060708'),
                channel: 11,
                channelMask: 0,
                nwkUpdateId: 0,
            });
            driverMock.getMacAddress.mockResolvedValue(Buffer.alloc(8));
            driverMock.getGlobalTcLinkKey.mockResolvedValue({
                linkKey: Buffer.alloc(16),
                outgoingFrameCounter: 1234,
            });
            driverMock.getNetworkKeyInfo.mockResolvedValue({
                nwkKey: Buffer.alloc(16),
                nwkKeySeqNum: 5,
                outgoingFrameCounter: 5678,
            });
            const expectedExtendedPanId = Buffer.from([8, 7, 6, 5, 4, 3, 2, 1]);
            const originalFrom = Buffer.from;
            const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((value: unknown, ...args: unknown[]) => {
                if (Array.isArray(value)) {
                    throw new Error('array-backed Buffer.from used');
                }

                return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
            }) as typeof Buffer.from);

            try {
                const result = await backup.createBackup();

                expect(result.networkOptions.extendedPanId).toEqual(expectedExtendedPanId);
                expect(fromSpy).not.toHaveBeenCalledWith(expect.any(Array));
            } finally {
                fromSpy.mockRestore();
            }
        });

        it('should copy backup-owned key and IEEE buffers without Buffer.from source clones', async () => {
            const linkKey = Buffer.of(1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16);
            const networkKey = Buffer.of(16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1);
            const ieee = Buffer.of(1, 2, 3, 4, 5, 6, 7, 8);
            driverMock.getCurrentNetworkParameters.mockResolvedValue({
                panId: 0x1234,
                extPanId: BigInt('0x0102030405060708'),
                channel: 11,
                channelMask: 0,
                nwkUpdateId: 0,
            });
            driverMock.getMacAddress.mockResolvedValue(ieee);
            driverMock.getGlobalTcLinkKey.mockResolvedValue({
                linkKey,
                outgoingFrameCounter: 1234,
            });
            driverMock.getNetworkKeyInfo.mockResolvedValue({
                nwkKey: networkKey,
                nwkKeySeqNum: 5,
                outgoingFrameCounter: 5678,
            });
            const originalFrom = Buffer.from;
            const fromSpy = vi.spyOn(Buffer, 'from').mockImplementation(((value: unknown, ...args: unknown[]) => {
                if (value === linkKey || value === networkKey || value === ieee) {
                    throw new Error('backup source buffer cloned');
                }

                return (originalFrom as (...parameters: unknown[]) => Buffer)(value, ...args);
            }) as typeof Buffer.from);

            try {
                const result = await backup.createBackup();

                expect(result.blz!.tclk).toEqual(linkKey);
                expect(result.networkOptions.networkKey).toEqual(networkKey);
                expect(result.coordinatorIeeeAddress).toEqual(ieee);
                expect(result.blz!.tclk).not.toBe(linkKey);
                expect(result.networkOptions.networkKey).not.toBe(networkKey);
                expect(result.coordinatorIeeeAddress).not.toBe(ieee);
                expect(fromSpy).not.toHaveBeenCalledWith(linkKey);
                expect(fromSpy).not.toHaveBeenCalledWith(networkKey);
                expect(fromSpy).not.toHaveBeenCalledWith(ieee);
            } finally {
                fromSpy.mockRestore();
            }
        });

        it('should not continue collecting backup data after the active guard fails', async () => {
            let finishLinkKeyRead: (() => void) | undefined;
            let active = true;
            driverMock.getGlobalTcLinkKey.mockReturnValue(
                new Promise((resolve) => {
                    finishLinkKeyRead = () =>
                        resolve({
                            linkKey: Buffer.alloc(16),
                            outgoingFrameCounter: 1234,
                        });
                }),
            );
            driverMock.getCurrentNetworkParameters.mockReturnValue(new Promise(() => {}));

            const result = (backup as unknown as {
                createBackup: (assertActive: () => void) => Promise<unknown>;
            }).createBackup(() => {
                if (!active) {
                    throw new Error('backup stopped');
                }
            }).catch((error: Error) => error.message);

            await Promise.resolve();
            active = false;
            finishLinkKeyRead?.();
            await Promise.resolve();

            expect(driverMock.getCurrentNetworkParameters).not.toHaveBeenCalled();
            await expect(result).resolves.toBe('backup stopped');
        });
    });

    describe('Loading backup', () => {
        it('should keep backup async errors on native throw paths', () => {
            const source = fs.readFileSync('src/adapter/blz/adapter/backup.ts', 'utf8');

            expect(source).not.toContain('return Promise.reject(');
            expect(source).not.toContain('return Promise.resolve(');
        });

        it('should load unified backup successfully', async () => {
            const mockBackupData = {
                metadata: {
                    format: 'zigpy/open-coordinator-backup',
                    version: 1,
                },
            };

            const mockParsedBackup = {
                networkOptions: {
                    panId: 0x1234,
                    extendedPanId: Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]),
                    channelList: [11],
                },
            };

            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
            vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from(JSON.stringify(mockBackupData)));
            vi.mocked(BackupUtils.fromUnifiedBackup).mockReturnValue(mockParsedBackup as any);

            const result = await backup.getStoredBackup();
            expect(result).toBe(mockParsedBackup);
        });

        it('should handle missing backup file', async () => {
            vi.mocked(fs.promises.access).mockRejectedValue(new Error('File not found'));

            const result = await backup.getStoredBackup();
            expect(result).toBeUndefined();
        });

        it('should handle corrupted backup file', async () => {
            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
            vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('invalid json'));

            await expect(backup.getStoredBackup()).rejects.toThrow('Coordinator backup is corrupted');
        });

        it('should handle unsupported backup version', async () => {
            const mockBackupData = {
                metadata: {
                    format: 'zigpy/open-coordinator-backup',
                    version: 2,
                },
            };

            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
            vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from(JSON.stringify(mockBackupData)));

            await expect(backup.getStoredBackup()).rejects.toThrow('Unsupported open coordinator backup version');
        });

        it('should reject invalid backup data before reading metadata', async () => {
            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
            vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from('null'));

            await expect(backup.getStoredBackup()).rejects.toThrow('Invalid backup data format');
        });

        it('should handle unknown backup format', async () => {
            const mockBackupData = {
                someOtherFormat: true,
            };

            vi.mocked(fs.promises.access).mockResolvedValue(undefined);
            vi.mocked(fs.promises.readFile).mockResolvedValue(Buffer.from(JSON.stringify(mockBackupData)));

            await expect(backup.getStoredBackup()).rejects.toThrow('Unknown backup format');
        });
    });
});
