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
    tradableRatio: number;
    tradableSnapshotSeconds: number[];
    earliestTradableSecondsBeforeEnd: number | null;
    latestTradableSecondsBeforeEnd: number | null;
    twoSidedSnapshots: number;
    twoSidedRatio: number;
    twoSidedSnapshotSeconds: number[];
    earliestTwoSidedSecondsBeforeEnd: number | null;
    latestTwoSidedSecondsBeforeEnd: number | null;
    oneSidedSnapshots: number;
    oneSidedRatio: number;
    oneSidedSnapshotSeconds: number[];
    earliestOneSidedSecondsBeforeEnd: number | null;
    latestOneSidedSecondsBeforeEnd: number | null;
    untradableSnapshots: number;
    untradableRatio: number;
    untradableSnapshotSeconds: number[];
    earliestUntradableSecondsBeforeEnd: number | null;
    latestUntradableSecondsBeforeEnd: number | null;
    stateTransitionCount: number;
    tradabilityTransitionCount: number;
    oneSidedReopenCount: number;
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

export type LiquidityWindowState = 'two-sided' | 'one-sided' | 'not-tradable';

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
    const orderedSnapshots = [...snapshots].sort((a, b) => b.secondsBeforeEnd - a.secondsBeforeEnd);
    const tradableSnapshotSeconds = snapshots
        .filter(isTradableSnapshot)
        .map((snap) => snap.secondsBeforeEnd)
        .sort((a, b) => b - a);
    const twoSidedSnapshotSeconds = snapshots
        .filter((snap) => isTwoSidedSnapshot(snap))
        .map((snap) => snap.secondsBeforeEnd)
        .sort((a, b) => b - a);
    const oneSidedSnapshotSeconds = snapshots
        .filter((snap) => isOneSidedSnapshot(snap))
        .map((snap) => snap.secondsBeforeEnd)
        .sort((a, b) => b - a);
    const untradableSnapshotSeconds = snapshots
        .filter((snap) => !isTradableSnapshot(snap))
        .map((snap) => snap.secondsBeforeEnd)
        .sort((a, b) => b - a);

    const emptyBookSnapshots = snapshots.filter(isEmptyBookSnapshot).length;
    const stateBySnapshot = orderedSnapshots.map((snap) => getSnapshotState(snap));
    let stateTransitionCount = 0;
    let tradabilityTransitionCount = 0;
    let oneSidedReopenCount = 0;
    for (let i = 1; i < stateBySnapshot.length; i++) {
        const prev = stateBySnapshot[i - 1];
        const curr = stateBySnapshot[i];
        if (prev !== curr) stateTransitionCount++;
        if ((prev === 'not-tradable') !== (curr === 'not-tradable')) tradabilityTransitionCount++;
        if (prev === 'one-sided' && curr === 'two-sided') oneSidedReopenCount++;
    }

    return {
        totalSnapshots: snapshots.length,
        emptyBookSnapshots,
        emptyBookRatio: snapshots.length > 0 ? emptyBookSnapshots / snapshots.length : 0,
        tradableSnapshots: tradableSnapshotSeconds.length,
        tradableRatio: snapshots.length > 0 ? tradableSnapshotSeconds.length / snapshots.length : 0,
        tradableSnapshotSeconds,
        earliestTradableSecondsBeforeEnd: tradableSnapshotSeconds[0] ?? null,
        latestTradableSecondsBeforeEnd: tradableSnapshotSeconds[tradableSnapshotSeconds.length - 1] ?? null,
        twoSidedSnapshots: twoSidedSnapshotSeconds.length,
        twoSidedRatio: snapshots.length > 0 ? twoSidedSnapshotSeconds.length / snapshots.length : 0,
        twoSidedSnapshotSeconds,
        earliestTwoSidedSecondsBeforeEnd: twoSidedSnapshotSeconds[0] ?? null,
        latestTwoSidedSecondsBeforeEnd: twoSidedSnapshotSeconds[twoSidedSnapshotSeconds.length - 1] ?? null,
        oneSidedSnapshots: oneSidedSnapshotSeconds.length,
        oneSidedRatio: snapshots.length > 0 ? oneSidedSnapshotSeconds.length / snapshots.length : 0,
        oneSidedSnapshotSeconds,
        earliestOneSidedSecondsBeforeEnd: oneSidedSnapshotSeconds[0] ?? null,
        latestOneSidedSecondsBeforeEnd: oneSidedSnapshotSeconds[oneSidedSnapshotSeconds.length - 1] ?? null,
        untradableSnapshots: untradableSnapshotSeconds.length,
        untradableRatio: snapshots.length > 0 ? untradableSnapshotSeconds.length / snapshots.length : 0,
        untradableSnapshotSeconds,
        earliestUntradableSecondsBeforeEnd: untradableSnapshotSeconds[0] ?? null,
        latestUntradableSecondsBeforeEnd: untradableSnapshotSeconds[untradableSnapshotSeconds.length - 1] ?? null,
        stateTransitionCount,
        tradabilityTransitionCount,
        oneSidedReopenCount,
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
        && 'tradableRatio' in profile
        && 'twoSidedSnapshots' in profile
        && 'oneSidedRatio' in profile
        && 'untradableSnapshots' in profile
        && 'stateTransitionCount' in profile
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

export function getSnapshotState(snap: PricingSnapshot): LiquidityWindowState {
    if (isTwoSidedSnapshot(snap)) return 'two-sided';
    if (isOneSidedSnapshot(snap)) return 'one-sided';
    return 'not-tradable';
}

export function getWindowState<T extends PricingSnapshot>(
    snapshots: T[],
    minSecondsBeforeEnd: number,
    maxSecondsBeforeEnd: number,
): LiquidityWindowState {
    if (findTwoSidedSnapshotInWindow(snapshots, minSecondsBeforeEnd, maxSecondsBeforeEnd)) return 'two-sided';
    if (findOneSidedSnapshotInWindow(snapshots, minSecondsBeforeEnd, maxSecondsBeforeEnd)) return 'one-sided';
    return 'not-tradable';
}

export function bucketFirstTradableTime(secondsBeforeEnd: number | null): string {
    if (secondsBeforeEnd === null) return 'never';
    if (secondsBeforeEnd >= 210) return 't210_or_earlier';
    if (secondsBeforeEnd >= 180) return 't180_to_t209';
    if (secondsBeforeEnd >= 150) return 't150_to_t179';
    if (secondsBeforeEnd >= 120) return 't120_to_t149';
    if (secondsBeforeEnd >= 90) return 't90_to_t119';
    if (secondsBeforeEnd >= 60) return 't60_to_t89';
    if (secondsBeforeEnd >= 30) return 't30_to_t59';
    return 'later_than_t30';
}

export function bucketFirstOneSidedTime(secondsBeforeEnd: number | null): string {
    if (secondsBeforeEnd === null) return 'never_one_sided_in_sample';
    if (secondsBeforeEnd >= 110) return 'already_one_sided_by_t120';
    if (secondsBeforeEnd >= 80) return 'collapses_between_t120_and_t90';
    if (secondsBeforeEnd >= 50) return 'collapses_between_t90_and_t60';
    return 'still_two_sided_through_t60';
}
