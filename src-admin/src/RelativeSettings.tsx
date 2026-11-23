import React, { useEffect, useState } from 'react';
import {
    Box,
    Button,
    Chip,
    Dialog,
    DialogActions,
    DialogContent,
    DialogTitle,
    FormControlLabel,
    MenuItem,
    Stack,
    Switch,
    TextField,
    Typography,
} from '@mui/material';
import type { Language } from '../../src/types/api';
import type { RelativeProfile, RelativeProfiles } from '../../src/commands/RelativeValue';
import type { CustomColor } from '../../src/commands/NamedColors';
import defaults from '../../resources/relative/profiles.json';
import de from '../../resources/admin/relative.de.json';
import en from '../../resources/admin/relative.en.json';

const words: Record<Language, Record<string, string>> = { de, en };
const intensities = ['tiny', 'small', 'normal', 'large', 'max'] as const;
const allKeys = Object.keys(defaults);

export function profileKeyFor(
    role: string | undefined,
    unit: string | undefined,
    enumValues?: Array<string | number>,
): string | undefined {
    if (role === 'level.color.temperature' && unit === 'K') return 'colorTemperature:K';
    if ((role === 'value.temperature' || role === 'level.temperature') && (unit === '°C' || unit === '°F'))
        return `temperature:${unit}`;
    if (role === 'level.blind') return 'position:%';
    if (role === 'level.tilt') return 'tilt:%';
    if (role === 'level.volume' || role === 'value.volume') return 'volume:%';
    if (role === 'level.humidity' && unit === '%') return 'humidity:%';
    if (role === 'level.color.saturation') return 'saturation:%';
    if (role === 'level.brightness' || role === 'value.brightness') return 'brightness:%';
    if (role === 'value.humidity' && unit === '%') return 'humidity:%';
    if (role === 'level' && (enumValues?.length ?? 0) > 1) return 'fanSpeed:enum';
    return undefined;
}

export function profileKeysFor(
    role: string | undefined,
    unit: string | undefined,
    enumValues?: Array<string | number>,
): string[] {
    const specific = profileKeyFor(role, unit, enumValues);
    if (specific) return [specific];
    if (role === 'level' && unit === '%') return allKeys.filter(key => key.endsWith(':%'));
    return [];
}

export function ProfileDialog({
    open,
    language,
    title,
    keys = allKeys,
    profiles,
    inherited = {},
    allowDirection = false,
    onClose,
    onSave,
}: {
    open: boolean;
    language: Language;
    title: string;
    keys?: string[];
    profiles: RelativeProfiles;
    inherited?: RelativeProfiles;
    allowDirection?: boolean;
    onClose: () => void;
    onSave: (profiles: RelativeProfiles) => Promise<boolean>;
}): React.JSX.Element {
    const w = words[language];
    const [key, setKey] = useState(keys[0] ?? '');
    const [draft, setDraft] = useState<RelativeProfiles>(profiles);
    const [saving, setSaving] = useState(false);
    useEffect(() => {
        if (open) {
            setDraft(profiles);
            setKey(keys[0] ?? '');
        }
    }, [open, profiles, keys.join('|')]);
    const current: RelativeProfile = draft[key] ?? {};
    const builtin = (defaults as Record<string, number[]>)[key] ?? [];
    const inheritedProfile = inherited[key] ?? {};
    const effective = (field: (typeof intensities)[number]): number | undefined =>
        current[field] ?? inheritedProfile[field] ?? builtin[intensities.indexOf(field)];
    const change = (field: keyof RelativeProfile, value: number | boolean | undefined): void => {
        const next = { ...current };
        if (value === undefined) delete next[field];
        else Object.assign(next, { [field]: value });
        setDraft({ ...draft, [key]: next });
    };
    const save = async (): Promise<void> => {
        setSaving(true);
        try {
            if (await onSave(draft)) {
                onClose();
            }
        } finally {
            setSaving(false);
        }
    };
    return (
        <Dialog
            open={open}
            onClose={onClose}
            fullWidth
            maxWidth="sm"
        >
            <DialogTitle>{title}</DialogTitle>
            <DialogContent dividers>
                <Stack
                    spacing={2}
                    sx={{ pt: 1 }}
                >
                    <TextField
                        select
                        label={w.profile}
                        value={key}
                        onChange={event => setKey(event.target.value)}
                    >
                        {keys.map(item => (
                            <MenuItem
                                key={item}
                                value={item}
                            >
                                {item}
                            </MenuItem>
                        ))}
                    </TextField>
                    <Chip
                        label={Object.keys(current).length ? w.local : w.inherited}
                        size="small"
                        sx={{ alignSelf: 'start' }}
                    />
                    <Typography
                        variant="body2"
                        color="text.secondary"
                    >
                        {w.source}
                    </Typography>
                    <Stack
                        direction={{ xs: 'column', sm: 'row' }}
                        spacing={1}
                    >
                        {intensities.map((field, index) => (
                            <TextField
                                key={field}
                                type="number"
                                label={w[field]}
                                value={current[field] ?? ''}
                                placeholder={String(inheritedProfile[field] ?? builtin[index] ?? '')}
                                onChange={event =>
                                    change(field, event.target.value === '' ? undefined : Number(event.target.value))
                                }
                                slotProps={{ htmlInput: { min: 0.001, step: 'any' } }}
                                helperText={`${w.inherited}: ${effective(field) ?? '—'}`}
                            />
                        ))}
                    </Stack>
                    <TextField
                        type="number"
                        label={w.step}
                        value={current.step ?? ''}
                        onChange={event =>
                            change('step', event.target.value === '' ? undefined : Number(event.target.value))
                        }
                        slotProps={{ htmlInput: { min: 0.001, step: 'any' } }}
                    />
                    <FormControlLabel
                        control={
                            <Switch
                                checked={current.enabled ?? inheritedProfile.enabled ?? true}
                                onChange={event => change('enabled', event.target.checked)}
                            />
                        }
                        label={w.enabled}
                    />
                    {allowDirection && (
                        <FormControlLabel
                            control={
                                <Switch
                                    checked={current.inverted ?? inheritedProfile.inverted ?? false}
                                    onChange={event => change('inverted', event.target.checked)}
                                />
                            }
                            label={w.inverted}
                        />
                    )}
                </Stack>
            </DialogContent>
            <DialogActions>
                <Button onClick={() => setDraft({ ...draft, [key]: {} })}>{w.reset}</Button>
                <Button onClick={onClose}>{w.close}</Button>
                <Button
                    onClick={() => void save()}
                    disabled={saving || !key}
                    variant="contained"
                >
                    {w.save}
                </Button>
            </DialogActions>
        </Dialog>
    );
}

export function CustomColorsEditor({
    language,
    colors,
    onSave,
}: {
    language: Language;
    colors: CustomColor[];
    onSave: (colors: CustomColor[]) => Promise<boolean>;
}): React.JSX.Element {
    const w = words[language];
    const [draft, setDraft] = useState<CustomColor[]>(colors);
    const [name, setName] = useState('');
    const [hex, setHex] = useState('');
    const [colorLanguage, setColorLanguage] = useState<Language>(language);
    useEffect(() => setDraft(colors), [colors]);
    return (
        <Box>
            <Typography variant="h6">{w.customColors}</Typography>
            <Typography
                variant="body2"
                sx={{ mb: 1 }}
            >
                {w.customColorsHint}
            </Typography>
            <Stack spacing={1}>
                {draft.map((item, index) => (
                    <Stack
                        direction="row"
                        spacing={1}
                        key={`${item.language}:${item.name}:${index}`}
                        sx={{ alignItems: 'center' }}
                    >
                        <Typography sx={{ flex: 1 }}>
                            {item.language}: {item.name} → {item.hex}
                        </Typography>
                        <Button onClick={() => setDraft(draft.filter((_entry, i) => i !== index))}>{w.delete}</Button>
                    </Stack>
                ))}
                <Stack
                    direction={{ xs: 'column', sm: 'row' }}
                    spacing={1}
                >
                    <TextField
                        select
                        label={w.language}
                        value={colorLanguage}
                        onChange={event => setColorLanguage(event.target.value as Language)}
                        sx={{ minWidth: 90 }}
                    >
                        <MenuItem value="de">DE</MenuItem>
                        <MenuItem value="en">EN</MenuItem>
                    </TextField>
                    <TextField
                        label={w.name}
                        value={name}
                        onChange={event => setName(event.target.value)}
                    />
                    <TextField
                        label={w.hex}
                        value={hex}
                        onChange={event => setHex(event.target.value)}
                    />
                    <Button
                        disabled={!name.trim() || !/^#[0-9a-f]{6}$/i.test(hex)}
                        onClick={() => {
                            setDraft([
                                ...draft,
                                { language: colorLanguage, name: name.trim(), hex: hex.toLowerCase() },
                            ]);
                            setName('');
                            setHex('');
                        }}
                    >
                        {w.add}
                    </Button>
                </Stack>
                <Button
                    variant="outlined"
                    sx={{ alignSelf: 'start' }}
                    onClick={() => void onSave(draft)}
                >
                    {w.save}
                </Button>
            </Stack>
        </Box>
    );
}

export function relativeWords(language: Language): Record<string, string> {
    return words[language];
}
