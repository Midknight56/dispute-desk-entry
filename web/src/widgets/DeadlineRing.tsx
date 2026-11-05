import { colors } from '../theme';
import { windowLeft } from './deadline';
import { formatDeadline } from '../format';

export default function DeadlineRing({
  created,
  due,
  now = Date.now(),
}: {
  created?: string;
  due: string | null;
  now?: number;
}) {
  if (!created || !due) return null;
  const left = windowLeft(created, due, now);
  if (!left) return null;
  const radius = 19;
  const circumference = 2 * Math.PI * radius;
  const color = left.share > 0.5 ? colors.ok : left.share >= 0.2 ? colors.warn : colors.danger;
  const text = formatDeadline(due, now);
  const parts = text.split(' ');
  return (
    <svg className="deadline-ring" viewBox="0 0 44 44" role="img" aria-label={text === 'Late' ? 'Late' : `${text} left`}>
      <circle cx="22" cy="22" r={radius} fill="none" stroke="var(--line)" strokeWidth="3" />
      <circle
        cx="22"
        cy="22"
        r={radius}
        fill="none"
        stroke={color}
        strokeWidth="3"
        strokeDasharray={`${circumference * left.share} ${circumference}`}
        transform="rotate(-90 22 22)"
      />
      <text x="22" y={parts.length === 2 ? '20' : '25'} textAnchor="middle" fill="var(--text)" fontSize={parts.length === 2 ? '10' : '11'}>
        {parts.length === 2 ? <>
          <tspan x="22" dy="0">{parts[0]}</tspan>
          <tspan x="22" dy="10">{parts[1]}</tspan>
        </> : parts[0]}
      </text>
    </svg>
  );
}
