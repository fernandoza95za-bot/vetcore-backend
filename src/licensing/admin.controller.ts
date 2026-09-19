import { Body, Controller, Get, Param, ParseIntPipe, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { JwtAdminGuard } from '../admin-auth/jwt-admin.guard.js';
import { LicensingService, type DeviceStatus } from './licensing.service.js';
import { ApproveDeviceDto, CreateClinicDto, UpdateDefaultTrialDaysDto, UpdateLicenseDto } from './dto/admin.dto.js';

@Controller('admin')
@UseGuards(JwtAdminGuard)
export class AdminLicensingController {
  constructor(private readonly licensing: LicensingService) {}

  @Get('clinics')
  listClinics() {
    return this.licensing.listClinicsWithLicenses();
  }

  @Post('clinics')
  createClinic(@Body() dto: CreateClinicDto) {
    return this.licensing.createClinicWithLicense(dto);
  }

  @Patch('licenses/:id')
  updateLicense(@Param('id', ParseIntPipe) id: number, @Body() dto: UpdateLicenseDto) {
    return this.licensing.updateLicense(id, dto);
  }

  /** Cuántos días de prueba le tocan, por defecto, a una clínica nueva (editable, 60 de fábrica). */
  @Get('settings/trial-days')
  async getDefaultTrialDays() {
    return { defaultTrialDays: await this.licensing.getDefaultTrialDays() };
  }

  @Patch('settings/trial-days')
  updateDefaultTrialDays(@Body() dto: UpdateDefaultTrialDaysDto) {
    return this.licensing.setDefaultTrialDays(dto.days);
  }

  @Get('devices')
  listDevices(@Query('status') status?: DeviceStatus) {
    return this.licensing.listDevices(status);
  }

  @Post('devices/:id/approve')
  approveDevice(@Param('id', ParseIntPipe) id: number, @Body() dto: ApproveDeviceDto) {
    return this.licensing.approveDevice(id, dto.approvedBy ?? 'admin');
  }

  @Post('devices/:id/revoke')
  revokeDevice(@Param('id', ParseIntPipe) id: number) {
    return this.licensing.revokeDevice(id);
  }
}
