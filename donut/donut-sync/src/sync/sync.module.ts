import { Module } from "@nestjs/common";
import { AuthGuard } from "../auth/auth.guard.js";
import { InternalController } from "./internal.controller.js";
import { LocksController } from "./locks.controller.js";
import { LocksService } from "./locks.service.js";
import { SyncController } from "./sync.controller.js";
import { SyncService } from "./sync.service.js";

@Module({
  controllers: [SyncController, LocksController, InternalController],
  providers: [SyncService, LocksService, AuthGuard],
  exports: [SyncService],
})
export class SyncModule {}
