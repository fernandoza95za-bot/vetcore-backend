import { IsBoolean, IsIn, IsInt, IsOptional, IsString, Min, MinLength, ValidateIf } from 'class-validator';

export class CreateClinicDto {
  @IsString()
  @MinLength(1)
  name!: string;

  @IsOptional()
  @IsString()
  contactName?: string;

  @IsOptional()
  @IsString()
  contactEmail?: string;

  @IsOptional()
  @IsString()
  contactPhone?: string;

  @IsOptional()
  @IsString()
  notes?: string;

  @IsIn(['saas', 'lifetime'])
  licenseType!: 'saas' | 'lifetime';

  @IsInt()
  @Min(1)
  maxDevices!: number;
}

export class UpdateLicenseDto {
  @IsOptional()
  @IsIn(['activa', 'suspendida', 'cancelada'])
  status?: 'activa' | 'suspendida' | 'cancelada';

  @IsOptional()
  @IsIn(['saas', 'lifetime', 'trial'])
  licenseType?: 'saas' | 'lifetime' | 'trial';

  @IsOptional()
  @IsInt()
  @Min(1)
  maxDevices?: number;

  @IsOptional()
  @IsString()
  paidThrough?: string;

  /**
   * true: marca esta clínica (necesariamente en modo de prueba) como que ya
   * necesita una licencia real, a partir de ahora — dispara el aviso de
   * unos días antes de bloquear. false: quita esa marca (por ejemplo, si el
   * dueño se equivocó o quiere darle más tiempo). Cambiar licenseType a algo
   * distinto de 'trial' también la quita, porque deja de aplicar.
   */
  @IsOptional()
  @IsBoolean()
  requiresLicense?: boolean;

  /**
   * Cuántos días de prueba le tocan a ESTA clínica en particular (manda
   * sobre el valor global). `null` quita el valor propio y vuelve a usar el
   * global; se deja sin mandar el campo para no tocarlo.
   */
  @IsOptional()
  @ValidateIf((_o, value) => value !== null)
  @IsInt()
  @Min(1)
  trialDays?: number | null;
}

export class ApproveDeviceDto {
  @IsOptional()
  @IsString()
  approvedBy?: string;
}

export class UpdateDefaultTrialDaysDto {
  @IsInt()
  @Min(1)
  days!: number;
}
