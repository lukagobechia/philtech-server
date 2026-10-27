import { Column, Entity, Index } from 'typeorm';
import { BaseEntity } from './base.entity.js';

export enum EmailOutboxStatus {
  PENDING = 'pending',
  SENT = 'sent',
  FAILED = 'failed',
}

@Entity({ name: 'email_outbox' })
@Index(['status', 'nextAttemptAt'])
export class EmailOutbox extends BaseEntity {
  @Column({ type: 'jsonb' })
  to!: string[];

  @Column({ type: 'varchar', length: 64 })
  template!: string;

  @Column({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Column({
    type: 'enum',
    enum: EmailOutboxStatus,
    default: EmailOutboxStatus.PENDING,
  })
  status!: EmailOutboxStatus;

  @Column({ type: 'int', default: 0 })
  attempts!: number;

  @Column({ type: 'timestamptz', default: () => 'now()' })
  nextAttemptAt!: Date;

  @Column({ type: 'text', nullable: true })
  lastError!: string | null;

  @Column({ type: 'timestamptz', nullable: true })
  sentAt!: Date | null;
}
