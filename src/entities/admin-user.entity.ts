import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity.js';

export enum AdminRole {
  ADMIN = 'admin',
  RECRUITER = 'recruiter',
}

@Entity({ name: 'admin_users' })
export class AdminUser extends BaseEntity {
  @Index({ unique: true })
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 255 })
  passwordHash!: string;

  @Column({ type: 'varchar', length: 160 })
  displayName!: string;

  @Column({ type: 'enum', enum: AdminRole, default: AdminRole.RECRUITER })
  role!: AdminRole;

  @Column({ type: 'boolean', default: true })
  isActive!: boolean;

  @Column({ type: 'timestamptz', nullable: true })
  lastLoginAt!: Date | null;
}
