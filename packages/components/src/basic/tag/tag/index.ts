import type { VariantProps } from 'class-variance-authority'
import { cva } from 'class-variance-authority'

export { default as Tag } from './Tag.vue'

export const tagVariants = cva(
  'inline-flex items-center gap-1 rounded-md border font-semibold transition-colors',
  {
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground',
        destructive:
          'border-transparent bg-destructive text-white dark:bg-destructive/60',
        outline:
          'border bg-background text-foreground dark:bg-input/30 dark:border-input',
        secondary:
          'border-transparent bg-secondary text-secondary-foreground',
      },
      size: {
        default: 'px-2.5 py-0.5 text-xs',
        sm: 'h-5 px-1.5 text-xs leading-none',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  },
)

export type TagVariants = VariantProps<typeof tagVariants>
