import { Column, Entity, Index } from 'typeorm';
import { encrypted } from '../lib/field-encryption.js';
import { BaseEntity } from './base.entity.js';
import { ContactService } from './contact-message.entity.js';
import { Locale } from './enums.js';

export enum CallBookingStatus {
  REQUESTED = 'requested',
  CONFIRMED = 'confirmed',
  CANCELLED = 'cancelled',
  COMPLETED = 'completed',
}

export const ACTIVE_BOOKING_STATUSES = [
  CallBookingStatus.REQUESTED,
  CallBookingStatus.CONFIRMED,
];

@Entity({ name: 'call_bookings' })
@Index(['startsAt', 'status'])
// Prevents two active bookings for the same slot, even under concurrent requests.
@Index('UQ_call_bookings_active_slot', ['startsAt'], {
  unique: true,
  where: `"status" IN ('requested', 'confirmed')`,
})
export class CallBooking extends BaseEntity {
  @Column({ type: 'text', transformer: encrypted })
  name!: string;

  @Column({ type: 'text', transformer: encrypted })
  email!: string;

  @Column({ type: 'text', nullable: true, transformer: encrypted })
  phone!: string | null;

  @Column({ type: 'timestamptz' })
  startsAt!: Date;

  // Timezone of the visitor, used for confirmation emails.
  @Column({ type: 'varchar', length: 64, default: 'Asia/Tbilisi' })
  timezone!: string;

  @Column({ type: 'enum', enum: ContactService, nullable: true })
  service!: ContactService | null;

  @Column({ type: 'text', nullable: true, transformer: encrypted })
  notes!: string | null;

  // Blind index for admin search over the encrypted fields, set on save; never returned.
  @Index('IDX_call_bookings_search_index', { synchronize: false })
  @Column({ type: 'text', array: true, default: () => "'{}'", select: false })
  searchIndex!: string[];

  @Column({ type: 'enum', enum: Locale, default: Locale.EN })
  locale!: Locale;

  @Column({ type: 'varchar', length: 64, nullable: true })
  ipHash!: string | null;

  @Column({
    type: 'enum',
    enum: CallBookingStatus,
    default: CallBookingStatus.REQUESTED,
  })
  status!: CallBookingStatus;
}
