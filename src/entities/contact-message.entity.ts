import { Column, Entity, Index } from 'typeorm';
import { encrypted } from '../lib/field-encryption.js';
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
  @Column({ type: 'text', transformer: encrypted })
  name!: string;

  @Column({ type: 'text', transformer: encrypted })
  email!: string;

  @Column({ type: 'text', nullable: true, transformer: encrypted })
  phone!: string | null;

  @Column({ type: 'text', nullable: true, transformer: encrypted })
  company!: string | null;

  @Column({ type: 'enum', enum: ContactService, nullable: true })
  service!: ContactService | null;

  @Column({ type: 'text', transformer: encrypted })
  message!: string;

  // Blind index for admin search over the encrypted fields, set on save; never returned.
  @Index('IDX_contact_messages_search_index', { synchronize: false })
  @Column({ type: 'text', array: true, default: () => "'{}'", select: false })
  searchIndex!: string[];

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
