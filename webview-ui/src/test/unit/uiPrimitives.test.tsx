// webview-ui/src/test/unit/uiPrimitives.test.tsx
//
// Smoke tests for the design-system primitives. Each test renders the
// primitive in isolation and verifies the DOM has the expected role
// or content. Catches the most common regressions:
//   - Broken imports / barrel-file mistakes
//   - Bad Radix ref forwarding (component crashes on mount)
//   - Tailwind class names that don't compile to CSS (wouldn't fail
//     the test, but builds error out)
//
// We deliberately don't snapshot or test interaction here. Visual
// fidelity is verified by running the extension manually; behavior
// is owned by Radix and tested upstream.

import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import {
    Button,
    Card,
    IconButton,
    Input,
    Pill,
    ScrollArea,
    Switch,
    Tabs,
    Textarea,
    ToggleGroup,
    Tooltip
} from '../../components/ui';

// File-local cleanup — registers in this file's lifecycle so it can't
// be defeated by setup.ts loading-order issues on Windows. See
// bashApprovalCard.test.tsx header comment for context.
afterEach(() => {
    cleanup();
});

describe('ui primitives — smoke', () => {
    it('Button renders with primary variant', () => {
        render(<Button variant="primary">Send</Button>);
        const btn = screen.getByRole('button', { name: 'Send' });
        expect(btn).toBeInTheDocument();
        expect(btn).toHaveAttribute('type', 'button');
    });

    it('IconButton renders with required aria-label', () => {
        render(
            <IconButton aria-label="Close">
                <svg />
            </IconButton>
        );
        expect(screen.getByRole('button', { name: 'Close' })).toBeInTheDocument();
    });

    it('Pill renders with status variant and dot', () => {
        render(<Pill variant="secure" showDot>Active</Pill>);
        expect(screen.getByText('Active')).toBeInTheDocument();
    });

    it('Card renders compound subcomponents', () => {
        render(
            <Card>
                <Card.Header>Header</Card.Header>
                <Card.Body>Body content</Card.Body>
                <Card.Footer>Footer</Card.Footer>
            </Card>
        );
        expect(screen.getByText('Header')).toBeInTheDocument();
        expect(screen.getByText('Body content')).toBeInTheDocument();
        expect(screen.getByText('Footer')).toBeInTheDocument();
    });

    it('Input renders text type by default', () => {
        render(<Input placeholder="Search" />);
        const input = screen.getByPlaceholderText('Search');
        expect(input).toBeInTheDocument();
        expect(input.tagName).toBe('INPUT');
    });

    it('Textarea renders with mono variant', () => {
        render(<Textarea mono placeholder="Prompt" />);
        const ta = screen.getByPlaceholderText('Prompt');
        expect(ta.tagName).toBe('TEXTAREA');
    });

    it('Switch renders with label', () => {
        render(<Switch id="s1" label="Enable" />);
        expect(screen.getByText('Enable')).toBeInTheDocument();
        // Radix renders a button[role="switch"]
        expect(screen.getByRole('switch')).toBeInTheDocument();
    });

    it('Tabs renders triggers and content', () => {
        render(
            <Tabs.Root defaultValue="a">
                <Tabs.List>
                    <Tabs.Trigger value="a">First</Tabs.Trigger>
                    <Tabs.Trigger value="b">Second</Tabs.Trigger>
                </Tabs.List>
                <Tabs.Content value="a">A content</Tabs.Content>
                <Tabs.Content value="b">B content</Tabs.Content>
            </Tabs.Root>
        );
        expect(screen.getByRole('tab', { name: 'First' })).toBeInTheDocument();
        expect(screen.getByText('A content')).toBeInTheDocument();
    });

    it('ToggleGroup renders single-select items', () => {
        render(
            <ToggleGroup.Root type="single" defaultValue="auto">
                <ToggleGroup.Item value="auto">Auto</ToggleGroup.Item>
                <ToggleGroup.Item value="plan">Plan</ToggleGroup.Item>
            </ToggleGroup.Root>
        );
        expect(screen.getByRole('group')).toBeInTheDocument();
    });

    it('Tooltip renders trigger', () => {
        render(
            <Tooltip.Provider>
                <Tooltip.Root>
                    <Tooltip.Trigger>Hover me</Tooltip.Trigger>
                    <Tooltip.Content>Label</Tooltip.Content>
                </Tooltip.Root>
            </Tooltip.Provider>
        );
        expect(screen.getByText('Hover me')).toBeInTheDocument();
    });

    it('ScrollArea renders children inside viewport', () => {
        render(
            <ScrollArea className="h-20">
                <div>scroll content</div>
            </ScrollArea>
        );
        expect(screen.getByText('scroll content')).toBeInTheDocument();
    });
});