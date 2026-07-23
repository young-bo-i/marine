import {
  Body,
  Controller,
  HttpCode,
  Post,
  Req,
  UseGuards,
} from "@nestjs/common";
import type { Request } from "express";
import { AuthGuard } from "../auth/auth.guard.js";
import type { UserContext } from "../auth/user-context.interface.js";
import type {
  LockAcquireRequestDto,
  LockAcquireResponseDto,
  LockOkResponseDto,
  LockRefRequestDto,
  LocksListResponseDto,
} from "./dto/locks.dto.js";
import { LocksService } from "./locks.service.js";

/** Cross-device profile mutual exclusion. See LocksService for the design. */
@Controller("v1/locks")
@UseGuards(AuthGuard)
export class LocksController {
  constructor(private readonly locks: LocksService) {}

  private ctx(req: Request): UserContext {
    return (req as unknown as Record<string, unknown>).user as UserContext;
  }

  @Post("acquire")
  @HttpCode(200)
  acquire(
    @Body() dto: LockAcquireRequestDto,
    @Req() req: Request,
  ): Promise<LockAcquireResponseDto> {
    return this.locks.acquire(dto, this.ctx(req));
  }

  @Post("heartbeat")
  @HttpCode(200)
  heartbeat(
    @Body() dto: LockRefRequestDto,
    @Req() req: Request,
  ): Promise<LockOkResponseDto> {
    return this.locks.heartbeat(dto, this.ctx(req));
  }

  @Post("release")
  @HttpCode(200)
  release(
    @Body() dto: LockRefRequestDto,
    @Req() req: Request,
  ): Promise<LockOkResponseDto> {
    return this.locks.release(dto, this.ctx(req));
  }

  @Post("list")
  @HttpCode(200)
  list(@Req() req: Request): Promise<LocksListResponseDto> {
    return this.locks.list(this.ctx(req));
  }
}
