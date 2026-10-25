import { Module } from "@nestjs/common";
import { APP_GUARD } from "@nestjs/core";
import { AuthController } from "./auth.controller";
import { AuthGuard } from "./auth.guard";
import { AuthService } from "./auth.service";
import { StaffController } from "./staff.controller";
import { StaffService } from "./staff.service";

@Module({
  controllers: [AuthController, StaffController],
  providers: [AuthService, StaffService, { provide: APP_GUARD, useClass: AuthGuard }],
  exports: [AuthService],
})
export class AuthModule {}
