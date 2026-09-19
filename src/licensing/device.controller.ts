import { Body, Controller, Post } from '@nestjs/common';
import { LicensingService } from './licensing.service.js';
import { ActivateDto, BranchBundleDto, HeartbeatDto, RegisterTrialDto } from './dto/device.dto.js';

/**
 * Endpoints que llama la app de escritorio directamente — sin sesión de
 * administrador, protegidos únicamente por conocer la clave de licencia
 * (que el dueño de la clínica recibe al comprar) más el HWID del equipo.
 */
@Controller('v1')
export class DeviceController {
  constructor(private readonly licensing: LicensingService) {}

  @Post('activate')
  activate(@Body() dto: ActivateDto) {
    return this.licensing.activate({
      licenseKey: dto.licenseKey,
      hwid: dto.hwid,
      deviceName: dto.deviceName,
      deviceRole: dto.deviceRole ?? 'secundario',
      branchLabel: dto.branchLabel,
    });
  }

  @Post('heartbeat')
  heartbeat(@Body() dto: HeartbeatDto) {
    return this.licensing.heartbeat({ licenseKey: dto.licenseKey, hwid: dto.hwid });
  }

  @Post('branch-bundle')
  branchBundle(@Body() dto: BranchBundleDto) {
    return this.licensing.branchBundle({ licenseKey: dto.licenseKey, hwid: dto.hwid });
  }

  /**
   * Registro silencioso de prueba: lo llama la app en el primer arranque
   * cuando todavía no tiene ninguna clave de licencia. No requiere sesión ni
   * clave — cualquiera puede darse de alta una clínica en modo de prueba,
   * que es justo el punto (bajar la fricción de instalación).
   */
  @Post('register')
  register(@Body() dto: RegisterTrialDto) {
    return this.licensing.registerTrial({
      clinicName: dto.clinicName,
      contactName: dto.contactName,
      contactEmail: dto.contactEmail,
      contactPhone: dto.contactPhone,
      hwid: dto.hwid,
      deviceName: dto.deviceName,
    });
  }
}
