import { Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, type Relation } from 'typeorm';
import { encryptedJson } from '../lib/field-encryption.js';
import { AdminUser } from './admin-user.entity.js';
import { Employee } from './employee.entity.js';

export enum EmployeeEventType {
  HIRED = 'hired',
  CREATED = 'created',
  UPDATED = 'updated',
  SCHEDULE_UPDATED = 'schedule_updated',
  DEACTIVATED = 'deactivated',
  REACTIVATED = 'reactivated',
  OVERTIME_STARTED = 'overtime_started',
  OVERTIME_ENDED = 'overtime_ended',
  OVERTIME_UPDATED = 'overtime_updated',
  OVERTIME_CANCELLED = 'overtime_cancelled',
}

/** Append-only activity log for an employee: who did what, when, with the details at the time. */
@Entity({ name: 'employee_events' })
@Index(['employeeId', 'createdAt'])
export class EmployeeEvent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @CreateDateColumn({ type: 'timestamptz' })
  createdAt!: Date;

  @ManyToOne(() => Employee, { nullable: false, onDelete: 'CASCADE' })
  @JoinColumn({ name: 'employee_id' })
  employee!: Relation<Employee>;

  @Column({ name: 'employee_id', type: 'uuid' })
  employeeId!: string;

  @Column({ type: 'enum', enum: EmployeeEventType })
  type!: EmployeeEventType;

  // Encrypted: field changes include before/after names, emails and phones.
  @Column({ type: 'text', transformer: encryptedJson })
  data!: Record<string, unknown>;

  // Null for automatic actions, e.g. overtime ending at its planned time.
  @ManyToOne(() => AdminUser, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'actor_id' })
  actor!: Relation<AdminUser> | null;

  @Column({ name: 'actor_id', type: 'uuid', nullable: true })
  actorId!: string | null;
}
