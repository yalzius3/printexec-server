import { Module } from "@nestjs/common";
import { UploadsController } from "./uploads.controller";
import { UploadCookieGuard } from "../auth/upload-cookie.guard";

@Module({
  controllers: [UploadsController],
  providers: [UploadCookieGuard]
})
export class UploadsModule {}
