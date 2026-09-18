export interface ChatContextDto {
    path?: string;
    content?: string;
}

export interface ChatRequestDto {
    message: string;
    context?: ChatContextDto;
}