export class LockAcquireRequestDto {
  profileId: string;
  deviceId: string;
  deviceName?: string;
}

export class LockAcquireResponseDto {
  acquired: boolean;
  // Present when acquired=false: who holds the lock.
  lockedBy?: string;
  lockedByName?: string;
  heartbeatAt?: string;
}

export class LockRefRequestDto {
  profileId: string;
  deviceId: string;
}

export class LockOkResponseDto {
  ok: boolean;
}

export class LockEntryDto {
  profileId: string;
  deviceId: string;
  deviceName: string;
  heartbeatAt: string;
}

export class LocksListResponseDto {
  locks: LockEntryDto[];
}
