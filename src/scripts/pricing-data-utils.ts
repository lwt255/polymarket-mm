export interface PricingSnapshot {
    secondsBeforeEnd: number;
    upBid: number;
    upAsk: number;
    downBid: number;
    downAsk: number;
    upMid: number;
    downMid: number;
}

export interface LiquidityProfile {
    totalSnapshots: number;
    emptyBookSnapshots: number;
    emptyBookRatio: number;
    tradableSnapshots: number;
    tradableSnapshotSeconds: number[];
    earliestTradableSecondsBeforeEnd: number | null;
    latestTradableSecondsBeforeEnd: number | null;
    oneSidedSnapshots: number;
    oneSidedSnapshotSeconds: number[];
    earliestOneSidedSecondsBeforeEnd: number | null;
    latestOneSidedSecondsBeforeEnd: number | null;
    hasTradableT120: boolean;
    hasTradableT60: boolean;
    hasTradableT30: boolean;
    hasTwoSidedT120: boolean;
    hasTwoSidedT90: boolean;
    hasTwoSidedT60: boolean;
    hasOneSidedT120: boolean;
    hasOneSidedT90: boolean;
    hasOneSidedT60: boolean;
}

export interface PricingRecordLike {
    snapshots: PricingSnapshot[];
    liquidityProfile?: LiquidityProfile;
}

export function isEmptyBookSnapshot(snap: Pick<PricingSnapshot, 'upBid' | 'upAsk' | 'downBid' | 'downAsk'>): boolean {
    return snap.upBid === 0 && snap.upAsk === 1 && snap.downBid === 0 && snap.downAsk === 1;
}

export function getUnderdogSide(snap: Pick<PricingSnapshot, 'upMid' | 'downMid'>): 'UP' | 'DOWN' {
    return snap.upMid < snap.downMid ? 'UP' : 'DOWN';
}

export function getFavoriteSide(snap: Pick<PricingSnapshot, 'upMid' | 'downMid'>): 'UP' | 'DOWN' {
    return getUnderdogSide(snap) === 'UP' ? 'DOWN' : 'UP';
}

export function getUnderdogAsk(snap: Pick<PricingSnapshot, 'upMid' | 'downMid' | 'upAsk' | 'downAsk'>): number {
    return getUnderdogSide(snap) === 'UP' ? snap.upAsk : snap.downAsk;
}

export function getFavoriteBid(snap: Pick<PricingSnapshot, 'upMid' | 'downMid' | 'upBid' | 'downBid'>): number {
    return getFavoriteSide(snap) === 'UP' ? snap.upBid : snap.downBid;
}

export function isTradableSnapshot(snap: PricingSnapshot): boolean {
    if (isEmptyBookSnapshot(snap)) return false;

    const entryAsk = getUnderdogAsk(snap);
    return entryAsk > 0 && entryAsk < 1;
}

export function isOneSidedSnapshot(snap: PricingSnapshot, opts?: { maxUnderdogAsk?: number; minFavoriteBid?: number }): boolean {
    if (!isTradableSnapshot(snap)) return false;

    const maxUnderdogAsk = opts?.maxUnderdogAsk ?? 0.03;
    const minFavoriteBid = opts?.minFavoriteBid ?? 0.97;

    return getUnderdogAsk(snap) <= maxUnderdogAsk || getFavoriteBid(snap) >= minFavoriteBid;
}

export function isTwoSidedSnapshot(snap: PricingSnapshot, opts?: { maxUnderdogAsk?: number; minFavoriteBid?: number }): boolean {
    return isTradableSnapshot(snap) && !isOneSidedSnapshot(snap, opts);
}

export function buildLiquidityProfile(snapshots: PricingSnapshot[]): LiquidityProfile {
    const tradableSnapshotSeconds = snapshots
        .filter(isTradableSnapshot)
        .map((snap) => snap.secondsBeforeEnd)
        .sort((a, b) => b - a);
    const oneSidedSnapshotSeconds = snapshots
        .filter((snap) => isOneSidedSnapshot(snap))
        .map((snap) => snap.secondsBeforeEnd)
        .sort((a, b) => b - a);

    const emptyBookSnapshots = snapshots.filter(isEmptyBookSnapshot).length;

    return {
        totalSnapshots: snapshots.length,
        emptyBookSnapshots,
        emptyBookRatio: snapshots.length > 0 ? emptyBookSnapshots / snapshots.length : 0,
        tradableSnapshots: tradableSnapshotSeconds.length,
        tradableSnapshotSeconds,
        earliestTradableSecondsBeforeEnd: tradableSnapshotSeconds[0] ?? null,
        latestTradableSecondsBeforeEnd: tradableSnapshotSeconds[tradableSnapshotSeconds.length - 1] ?? null,
        oneSidedSnapshots: oneSidedSnapshotSeconds.length,
        oneSidedSnapshotSeconds,
        earliestOneSidedSecondsBeforeEnd: oneSidedSnapshotSeconds[0] ?? null,
        latestOneSidedSecondsBeforeEnd: oneSidedSnapshotSeconds[oneSidedSnapshotSeconds.length - 1] ?? null,
        hasTradableT120: tradableSnapshotSeconds.some((sec) => sec >= 110 && sec <= 130),
        hasTradableT60: tradableSnapshotSeconds.some((sec) => sec >= 55 && sec <= 65),
        hasTradableT30: tradableSnapshotSeconds.some((sec) => sec >= 25 && sec <= 35),
        hasTwoSidedT120: snapshots.some((snap) => snap.secondsBeforeEnd >= 110 && snap.secondsBeforeEnd <= 130 && isTwoSidedSnapshot(snap)),
        hasTwoSidedT90: snapshots.some((snap) => snap.secondsBeforeEnd >= 80 && snap.secondsBeforeEnd <= 100 && isTwoSidedSnapshot(snap)),
        hasTwoSidedT60: snapshots.some((snap) => snap.secondsBeforeEnd >= 50 && snap.secondsBeforeEnd <= 70 && isTwoSidedSnapshot(snap)),
        hasOneSidedT120: snapshots.some((snap) => snap.secondsBeforeEnd >= 110 && snap.secondsBeforeEnd <= 130 && isOneSidedSnapshot(snap)),
        hasOneSidedT90: snapshots.some((snap) => snap.secondsBeforeEnd >= 80 && snap.secondsBeforeEnd <= 100 && isOneSidedSnapshot(snap)),
        hasOneSidedT60: snapshots.some((snap) => snap.secondsBeforeEnd >= 50 && snap.secondsBeforeEnd <= 70 && isOneSidedSnapshot(snap)),
    };
}

export function getLiquidityProfile(record: PricingRecordLike): LiquidityProfile {
    const profile = record.liquidityProfile;
    if (
        profile
        && 'oneSidedSnapshots' in profile
        && 'hasTwoSidedT120' in profile
        && 'hasOneSidedT120' in profile
    ) {
        return profile;
    }

    return buildLiquidityProfile(record.snapshots);
}

export function isStrategyUsableT120(record: PricingRecordLike): boolean {
    return getLiquidityProfile(record).hasTradableT120;
}

export function findTradableSnapshotInWindow<T extends PricingSnapshot>(
    snapshots: T[],
    minSecondsBeforeEnd: number,
    maxSecondsBeforeEnd: number,
): T | undefined {
    return snapshots.find((snap) =>
        snap.secondsBeforeEnd >= minSecondsBeforeEnd
        && snap.secondsBeforeEnd <= maxSecondsBeforeEnd
        && isTradableSnapshot(snap),
    );
}

export function findTwoSidedSnapshotInWindow<T extends PricingSnapshot>(
    snapshots: T[],
    minSecondsBeforeEnd: number,
    maxSecondsBeforeEnd: number,
): T | undefined {
    return snapshots.find((snap) =>
        snap.secondsBeforeEnd >= minSecondsBeforeEnd
        && snap.secondsBeforeEnd <= maxSecondsBeforeEnd
        && isTwoSidedSnapshot(snap),
    );
}

export function findOneSidedSnapshotInWindow<T extends PricingSnapshot>(
    snapshots: T[],
    minSecondsBeforeEnd: number,
    maxSecondsBeforeEnd: number,
): T | undefined {
    return snapshots.find((snap) =>
        snap.secondsBeforeEnd >= minSecondsBeforeEnd
        && snap.secondsBeforeEnd <= maxSecondsBeforeEnd
        && isOneSidedSnapshot(snap),
    );
}
