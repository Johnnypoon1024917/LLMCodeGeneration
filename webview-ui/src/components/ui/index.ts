// webview-ui/src/components/ui/index.ts
//
// Single import surface for the primitive library. Call sites should
// always import from here, never from the individual component files,
// so refactors stay centralized:
//
//   import { Button, Card, Pill } from '@/components/ui';
//
// (We don't have an `@/` path alias yet — using relative imports until
// PR 1.3 sets one up if needed.)

export { cn } from './cn';
export { Button, type ButtonProps } from './Button';
export { IconButton, type IconButtonProps } from './IconButton';
export { Pill, type PillProps } from './Pill';
export { Card, type CardProps, type CardHeaderProps } from './Card';
export { Input, type InputProps } from './Input';
export { Textarea, type TextareaProps } from './Textarea';
export { Switch, type SwitchProps } from './Switch';
export { Tabs } from './Tabs';
export { ToggleGroup } from './ToggleGroup';
export { Tooltip } from './Tooltip';
export { Dialog } from './Dialog';
export { ScrollArea, type ScrollAreaProps } from './ScrollArea';