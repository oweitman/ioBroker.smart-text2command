import React from 'react';
import {
    Box,
    IconButton,
    MenuItem,
    Table,
    TableBody,
    TableCell,
    TableContainer,
    TableHead,
    TableRow,
    TextField,
    Tooltip,
} from '@mui/material';
import AddIcon from '@mui/icons-material/Add';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutlined';
import languages from '../../resources/languages.json';
import type { Language } from '../../src/types/api';

export interface LanguageRow {
    key: number;
    language: Language;
    value: string;
}

export const languageOptions = languages as Array<{ code: Language; name: string }>;

export function rowsFromValues(values: Partial<Record<Language, string>>, primary: Language): LanguageRow[] {
    const codes = [primary, ...languageOptions.map(item => item.code).filter(code => code !== primary && values[code])];
    return codes.map((language, key) => ({ key, language, value: values[language] ?? '' }));
}

export function valuesFromRows(rows: LanguageRow[]): Partial<Record<Language, string>> {
    return Object.fromEntries(rows.map(row => [row.language, row.value])) as Partial<Record<Language, string>>;
}

interface Props {
    rows: LanguageRow[];
    onChange: (rows: LanguageRow[]) => void;
    languageHeader: string;
    valueHeader: string;
    addLabel: string;
    removeLabel: string;
    valueLabel: string;
}

export default function LanguageValueTable({
    rows,
    onChange,
    languageHeader,
    valueHeader,
    addLabel,
    removeLabel,
    valueLabel,
}: Props): React.JSX.Element {
    const unused = languageOptions.filter(option => !rows.some(row => row.language === option.code));
    return (
        <Box sx={{ width: { xs: '100%', md: '50%' }, minWidth: { md: 430 }, maxWidth: '100%' }}>
            <TableContainer sx={{ overflowX: 'auto' }}>
                <Table
                    size="small"
                    aria-label={valueHeader}
                >
                    <TableHead>
                        <TableRow>
                            <TableCell sx={{ width: 150 }}>{languageHeader}</TableCell>
                            <TableCell>{valueHeader}</TableCell>
                            <TableCell sx={{ width: 44 }} />
                        </TableRow>
                    </TableHead>
                    <TableBody>
                        {rows.map(row => (
                            <TableRow key={row.key}>
                                <TableCell>
                                    <TextField
                                        select
                                        size="small"
                                        fullWidth
                                        value={row.language}
                                        label={languageHeader}
                                        onChange={event =>
                                            onChange(
                                                rows.map(item =>
                                                    item.key === row.key
                                                        ? { ...item, language: event.target.value as Language }
                                                        : item,
                                                ),
                                            )
                                        }
                                    >
                                        {languageOptions.map(option => (
                                            <MenuItem
                                                key={option.code}
                                                value={option.code}
                                                disabled={rows.some(
                                                    item => item.key !== row.key && item.language === option.code,
                                                )}
                                            >
                                                {option.name}
                                            </MenuItem>
                                        ))}
                                    </TextField>
                                </TableCell>
                                <TableCell>
                                    <TextField
                                        size="small"
                                        fullWidth
                                        value={row.value}
                                        label={valueLabel}
                                        onChange={event =>
                                            onChange(
                                                rows.map(item =>
                                                    item.key === row.key
                                                        ? { ...item, value: event.target.value }
                                                        : item,
                                                ),
                                            )
                                        }
                                    />
                                </TableCell>
                                <TableCell>
                                    <Tooltip title={removeLabel}>
                                        <span>
                                            <IconButton
                                                size="small"
                                                aria-label={removeLabel}
                                                disabled={rows.length === 1}
                                                onClick={() => onChange(rows.filter(item => item.key !== row.key))}
                                            >
                                                <DeleteOutlineIcon fontSize="small" />
                                            </IconButton>
                                        </span>
                                    </Tooltip>
                                </TableCell>
                            </TableRow>
                        ))}
                    </TableBody>
                </Table>
            </TableContainer>
            <Tooltip title={addLabel}>
                <span>
                    <IconButton
                        size="small"
                        aria-label={addLabel}
                        disabled={unused.length === 0}
                        onClick={() =>
                            onChange([
                                ...rows,
                                {
                                    key: Math.max(...rows.map(row => row.key), -1) + 1,
                                    language: unused[0].code,
                                    value: '',
                                },
                            ])
                        }
                    >
                        <AddIcon />
                    </IconButton>
                </span>
            </Tooltip>
        </Box>
    );
}
