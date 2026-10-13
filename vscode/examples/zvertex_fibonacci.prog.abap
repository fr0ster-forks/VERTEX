REPORT zvertex_fibonacci.

" Local calculation example: place a breakpoint on either assignment.
DATA a TYPE i.
DATA b TYPE i.
DATA next_value TYPE i.
DATA step TYPE i.

a = 0.
b = 1.

DO 20 TIMES.
  step = sy-index.
  WRITE: / step, a.
  next_value = a + b.
  a = b.
  b = next_value.
ENDDO.
