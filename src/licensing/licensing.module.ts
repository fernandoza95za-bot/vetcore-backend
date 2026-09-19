import { Module } from '@nestjs/common';
import { AdminAuthModule } from '../admin-auth/admin-auth.module.js';
import { AdminLicensingController } from './admin.controller.js';
import { DeviceController } from './device.controller.js';
import { CreatorNotifierService } from './creator-notifier.service.js';
import { LicensingService } from './licensing.service.js';
import { TokenService } from './token.service.js';

@Module({
  imports: [AdminAuthModule],
  controllers: [DeviceController, AdminLicensingController],
  providers: [LicensingService, TokenService, CreatorNotifierService],
})
export class LicensingModule {}
