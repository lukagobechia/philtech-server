import { Column, Entity, Index } from 'typeorm';
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
  @Column({ type: 'varchar', length: 160 })
  name!: string;

  @Index()
  @Column({ type: 'varchar', length: 320 })
  email!: string;

  @Column({ type: 'varchar', length: 32, nullable: true })
  phone!: string | null;

  @Column({ type: 'timestamptz' })
  startsAt!: Date;

  // Timezone of the visitor, used for confirmation emails.
  @Column({ type: 'varchar', length: 64, default: 'Asia/Tbilisi' })
  timezone!: string;

  @Column({ type: 'enum', enum: ContactService, nullable: true })
  service!: ContactService | null;

  @Column({ type: 'text', nullable: true })
  notes!: string | null;

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
