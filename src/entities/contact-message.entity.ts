import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity.js';
import { Locale } from './enums.js';

export enum ContactMessageStatus {
  NEW = 'new',
  IN_PROGRESS = 'in_progress',
  RESOLVED = 'resolved',
  SPAM = 'spam',
}

export enum ContactService {
  UI_UX = 'ui_ux',
  WEB = 'web',
  MOBILE = 'mobile',
}

@Entity({ name: 'contact_messages' })
export class ContactMessage extends BaseEntity {
  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Index()
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'varchar', length: 160, nullable: true })
  company!: string | null;

  @Column({ type: 'enum', enum: ContactService, nullable: true })
  service!: ContactService | null;

  @Column({ type: 'text' })
  message!: string;

  @Column({ type: 'enum', enum: Locale, default: Locale.EN })
  locale!: Locale;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ipHash!: string | null;

  @Index()
  @Column({
    type: 'enum',
    enum: ContactMessageStatus,
    default: ContactMessageStatus.NEW,
  })
  status!: ContactMessageStatus;
}
