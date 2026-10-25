import { writable } from 'svelte/store';

export const todos = writable<string[]>([]);

todos.subscribe(value => localStorage.setItem('todos', JSON.stringify(value)));

const initialTodos = JSON.parse(localStorage.getItem('todos') || '[]');
todos.set(initialTodos);